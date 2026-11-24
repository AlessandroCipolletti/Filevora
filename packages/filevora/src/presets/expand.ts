import { z } from 'zod';
import { fail } from '../errors/error.js';
import {
  assetTransformOperationSchema,
  assertFrameOptions,
  isFrameOperation,
  mediaFamily,
  parseAssetTransform,
  validOperations,
  type AssetTransformOperation,
} from '../transform/schema.js';
import type { CustomPresetMap } from './schema.js';
import { findPreset, presetNamesFor, type NamedPreset } from './catalog.js';

const requestSchema = z
  .object({
    preset: z.string().min(1).optional(),
    replace: z.boolean().optional(),
    operations: z.array(assetTransformOperationSchema).max(8).optional(),
  })
  .strict();

export type ExpandedTransform =
  | {
      mode: 'operations';
      operations: AssetTransformOperation[];
      replace: boolean;
    }
  | {
      mode: 'versions';
      preset: NamedPreset;
    };

export function assertConfiguredPreset(
  name: string,
  custom: CustomPresetMap = {},
): void {
  if (findPreset(name, custom)) return;
  const names = [
    ...new Set([
      ...presetNamesFor('image', custom),
      ...presetNamesFor('video', custom),
    ]),
  ];
  throw fail('INVALID_CONFIG', {
    message: `Preset "${name}" is not built in or custom. Valid presets: ${names.join(', ')}.`,
  });
}

export function assertKnownPreset(
  name: string,
  custom: CustomPresetMap = {},
): NamedPreset {
  const preset = findPreset(name, custom);
  if (preset) return preset;
  const names = [
    ...presetNamesFor('image', custom),
    ...presetNamesFor('video', custom),
  ];
  const unique = [...new Set(names)];
  throw fail('TRANSFORM_REJECTED', {
    message: `Unknown preset "${name}". Valid presets: ${unique.join(', ')}.`,
    context: {
      field: 'preset',
      reason: `Unknown preset "${name}".`,
      detectedType: null,
      validOperations: [],
      validPresets: unique,
    },
  });
}

/** `skip` leaves non-media on the legacy web-optimized preset unprocessed. */
export function presetQueueAction(
  name: string,
  mime: string,
  custom: CustomPresetMap = {},
): 'queue' | 'skip' {
  const preset = assertKnownPreset(name, custom);
  if (preset.delivery === 'legacy') {
    return /^(image|video|audio)\//.test(mime) ? 'queue' : 'skip';
  }
  const family = familyOf(mime);
  if (preset.families.includes(family as 'image' | 'video' | 'audio')) {
    return 'queue';
  }
  const names = presetNamesFor(
    family === 'audio' ? 'audio' : family === 'image' ? 'image' : 'video',
    custom,
  );
  const applicable =
    family === 'image' || family === 'video' || family === 'audio' ? names : [];
  throw fail('TRANSFORM_REJECTED', {
    message: `Preset "${name}" does not apply to ${mime}. Valid presets: ${applicable.join(', ') || 'none'}.`,
    context: {
      field: 'preset',
      reason: `Preset "${name}" is for ${preset.families.join(', ')}, not ${mime}.`,
      detectedType: mime,
      validOperations: validOperations(mime),
      validPresets: applicable,
    },
  });
}

export function expandTransform(
  input: unknown,
  mime: string,
  custom: CustomPresetMap = {},
): ExpandedTransform {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (typeof record.preset !== 'string') {
    const parsed = parseAssetTransform(input);
    const frames = framePreset(parsed.operations);
    if (frames) return { mode: 'versions', preset: frames };
    return {
      mode: 'operations',
      operations: parsed.operations,
      replace: parsed.replace !== false,
    };
  }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw fail('TRANSFORM_REJECTED', {
      message: issue?.message ?? 'The transform config is invalid.',
      context: {
        field: issue?.path.join('.') || 'preset',
        reason: issue?.message ?? 'Invalid value.',
        detectedType: mime,
        validOperations: validOperations(mime),
        validPresets: presetNamesFor(familyOf(mime) as 'image', custom),
      },
    });
  }
  const preset = assertKnownPreset(parsed.data.preset ?? '', custom);
  const family = familyOf(mime);
  if (!preset.families.includes(family as 'image' | 'video' | 'audio')) {
    const action = presetQueueAction(preset.name, mime, custom);
    if (action === 'skip') {
      throw fail('TRANSFORM_REJECTED', {
        message: `Preset "${preset.name}" does not apply to ${mime}.`,
        context: {
          field: 'preset',
          reason: `Preset "${preset.name}" does not apply to ${mime}.`,
          detectedType: mime,
          validOperations: validOperations(mime),
          validPresets: [],
        },
      });
    }
  }
  const extra = parsed.data.operations ?? [];
  if (preset.delivery === 'legacy' || preset.delivery === 'versions') {
    if (extra.length > 0) {
      throw fail('TRANSFORM_REJECTED', {
        message: `Preset "${preset.name}" publishes versions. Pass operations without that preset to transform the original.`,
        context: {
          field: 'operations',
          reason: `Preset "${preset.name}" publishes ${preset.outputs.map((output) => output.version).join(', ')}.`,
          detectedType: mime,
          validOperations: validOperations(mime),
          validPresets: presetNamesFor(family as 'image', custom),
        },
      });
    }
    return { mode: 'versions', preset };
  }
  const base = preset.outputs[0]?.operations ?? [];
  return {
    mode: 'operations',
    operations: [...base, ...extra],
    replace: parsed.data.replace !== false,
  };
}

/** A transform that is only stills is stored on the job, not in the preset catalog. */
export function framePresetFromPayload(
  name: string,
  outputs: unknown,
): NamedPreset | undefined {
  if (name !== 'frames' || !Array.isArray(outputs)) return undefined;
  const parsed = z
    .array(
      z
        .object({
          version: z.string().min(1),
          operations: z.array(assetTransformOperationSchema).min(1).max(4),
        })
        .strict(),
    )
    .max(8)
    .safeParse(outputs);
  if (!parsed.success) return undefined;
  const normalized = parsed.data.map((output) => {
    output.operations.forEach((operation, index) =>
      assertFrameOptions(operation, `outputs.operations[${index}]`),
    );
    return output;
  });
  if (
    normalized.some((output) =>
      output.operations.some((operation) => !isFrameOperation(operation.op)),
    )
  ) {
    return undefined;
  }
  return {
    name: 'frames',
    families: ['video'],
    source: 'custom',
    delivery: 'versions',
    outputs: normalized,
  };
}

function framePreset(
  operations: AssetTransformOperation[],
): NamedPreset | undefined {
  if (
    operations.length === 0 ||
    operations.some((operation) => !isFrameOperation(operation.op))
  ) {
    return undefined;
  }
  const used = new Set<string>();
  const outputs = operations.map((operation) => {
    const base =
      operation.op === 'video.poster'
        ? 'poster'
        : operation.op === 'video.sprite'
          ? 'sprite'
          : 'thumb';
    let version = base;
    let suffix = 2;
    while (used.has(version)) {
      version = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(version);
    return { version, operations: [operation] };
  });
  return {
    name: 'frames',
    families: ['video'],
    source: 'custom',
    delivery: 'versions',
    outputs,
  };
}

function familyOf(mime: string): string {
  if (mime.startsWith('audio/')) return 'audio';
  return mediaFamily(mime);
}
