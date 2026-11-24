import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fail } from '../errors/error.js';
import {
  blockReason,
  decodeIPv4Hostname,
  isMetadataHost,
  type BlockReason,
} from './address.js';

export interface RemotePolicy {
  maxBytes: number;
  connectTimeoutMs: number;
  timeoutMs: number;
  maxRedirects: number;
  allowedPorts: number[];
  /** Lets the caller-supplied URL use loopback, private, and link-local addresses. */
  allowPrivate: boolean;
  allowHosts: string[];
  denyHosts: string[];
}

export interface CheckedRemoteUrl {
  url: URL;
  hostname: string;
  port: number;
  address: string;
}

const PRIVATE_REASONS = new Set<BlockReason>([
  'loopback',
  'private',
  'link-local',
  'unspecified',
]);

/**
 * Check one URL before a connection. A redirect hop does not inherit
 * `allowPrivate`, so a local server cannot bounce the download onto a LAN address.
 */
export async function checkRemoteUrl(
  raw: string,
  policy: RemotePolicy,
  hop: 'request' | 'redirect' = 'request',
): Promise<CheckedRemoteUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail('REMOTE_URL_SCHEME', {
      message: 'The remote URL is not a valid http or https URL.',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw fail('REMOTE_URL_SCHEME', {
      message: 'Only http and https URLs can be imported.',
      context: { protocol: url.protocol.replace(':', '') },
    });
  }
  if (url.username || url.password) {
    throw fail('REMOTE_URL_CREDENTIALS', {
      message: 'The remote URL must not contain a username or password.',
    });
  }
  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80;
  if (!policy.allowedPorts.includes(port)) {
    throw fail('REMOTE_URL_PORT', {
      message: 'The remote URL port is not in the allowed list.',
      context: { port },
    });
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!hostname) {
    throw fail('REMOTE_URL_SCHEME', {
      message: 'The remote URL is missing a host.',
    });
  }
  if (isMetadataHost(hostname) || hostListed(hostname, policy.denyHosts)) {
    throw fail(
      isMetadataHost(hostname) ? 'REMOTE_URL_BLOCKED' : 'REMOTE_URL_HOST',
      {
        message: isMetadataHost(hostname)
          ? 'The remote host is a cloud metadata name.'
          : 'The remote host is on the denylist.',
        context: { host: hostname },
      },
    );
  }
  if (
    policy.allowHosts.length > 0 &&
    !hostListed(hostname, policy.allowHosts)
  ) {
    throw fail('REMOTE_URL_HOST', {
      message: 'The remote host is not on the allowlist.',
      context: { host: hostname },
    });
  }
  const addresses = await addressesFor(hostname);
  const allowPrivate = hop === 'request' && policy.allowPrivate;
  for (const address of addresses) {
    const reason = blockReason(address);
    if (!reason) continue;
    if (
      reason === 'metadata' ||
      reason === 'multicast' ||
      reason === 'reserved'
    ) {
      throw blocked(hostname, address, reason);
    }
    if (!allowPrivate && PRIVATE_REASONS.has(reason)) {
      throw blocked(hostname, address, reason);
    }
  }
  const address = addresses[0];
  if (!address) {
    throw fail('REMOTE_URL_BLOCKED', {
      message: 'The remote host did not resolve.',
      context: { host: hostname },
    });
  }
  return { url, hostname, port, address };
}

async function addressesFor(hostname: string): Promise<string[]> {
  const decoded = decodeIPv4Hostname(hostname);
  if (decoded) return [decoded];
  if (isIP(hostname)) return [hostname];
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch {
    throw fail('REMOTE_URL_BLOCKED', {
      message: 'The remote host did not resolve.',
      context: { host: hostname },
    });
  }
}

function hostListed(hostname: string, list: string[]): boolean {
  const host = hostname.toLowerCase();
  return list.some((entry) => {
    const rule = entry.toLowerCase().replace(/\.+$/, '');
    if (rule.startsWith('.'))
      return host.endsWith(rule) || host === rule.slice(1);
    return host === rule;
  });
}

function blocked(host: string, address: string, reason: BlockReason) {
  return fail('REMOTE_URL_BLOCKED', {
    message: 'The remote address is not allowed.',
    context: { host, address, reason },
  });
}
