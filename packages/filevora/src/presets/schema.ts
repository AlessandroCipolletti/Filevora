import { z } from 'zod';
import { fail } from '../errors/error.js';
import {
  assertFrameOptions,
  assetTransformOperationSchema,
  isFrameOperation,
  type AssetTransformOperation,
} from '../transform/schema.js';

const presetName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,40}$/, 'Use a lowercase preset name.');

const versionName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,40}$/,
    'Use a version name of letters, numbers, "_" or "-".',
  );

export const customPresetSchema = z
  .object({
    family: z.enum(['image', 'video', 'pdf', 'audio']),
    version: versionName.optional(),
    operations: z.array(assetTransformOperationSchema).min(1).max(8),
  })
  .strict();

export const customPresetsSchema = z.record(presetName, customPresetSchema);

export interface CustomPreset {
  family: 'image' | 'video' | 'pdf' | 'audio';
  version: string;
  operations: AssetTransformOperation[];
}

export type CustomPresetMap = Record<string, CustomPreset>;

/** Parse `FILEVORA_PRESETS` or the `presets` config object. */
export function parseCustomPresets(
  value: unknown,
  builtinNames: ReadonlySet<string>,
): CustomPresetMap {
  if (value === undefined || value === null || value === '') return {};
  const parsed = customPresetsSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw fail('INVALID_CONFIG', {
      message: `Custom presets are invalid: ${issue?.message ?? 'bad value'} (${issue?.path.join('.') || 'presets'}).`,
    });
  }
  const map: CustomPresetMap = {};
  for (const [name, preset] of Object.entries(parsed.data)) {
    if (builtinNames.has(name)) {
      throw fail('INVALID_CONFIG', {
        message: `Custom preset "${name}" uses a built-in name.`,
      });
    }
    const frame = preset.operations.some((operation) =>
      isFrameOperation(operation.op),
    );
    const other = preset.operations.some(
      (operation) => !isFrameOperation(operation.op),
    );
    if (frame && other) {
      throw fail('INVALID_CONFIG', {
        message: `Custom preset "${name}" mixes frame stills with a video edit. Use one or the other.`,
      });
    }
    const pdfPages = preset.operations.some(
      (operation) => operation.op === 'pdf.pages',
    );
    const pdfEdit = preset.operations.some(
      (operation) => operation.op === 'pdf.removePages',
    );
    if (pdfPages && pdfEdit) {
      throw fail('INVALID_CONFIG', {
        message: `Custom preset "${name}" mixes page images with page removal. Use one or the other.`,
      });
    }
    preset.operations.forEach((operation, index) =>
      assertFrameOptions(operation, `${name}.operations[${index}]`),
    );
    for (const operation of preset.operations) {
      const kind = operation.op.split('.')[0];
      if (kind !== preset.family) {
        throw fail('INVALID_CONFIG', {
          message: `${operation.op} does not belong in a ${preset.family} preset.`,
        });
      }
    }
    const version = preset.version ?? name;
    if (version === 'original') {
      throw fail('INVALID_CONFIG', {
        message: 'A preset version cannot be named original.',
      });
    }
    map[name] = {
      family: preset.family,
      version,
      operations: preset.operations,
    };
  }
  return map;
}

export function parsePresetJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw fail('INVALID_CONFIG', {
      message: 'FILEVORA_PRESETS must be a JSON object of custom presets.',
    });
  }
}
