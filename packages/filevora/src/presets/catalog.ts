import {
  isFrameOperation,
  type AssetTransformOperation,
} from '../transform/schema.js';
import {
  type CustomPreset,
  type CustomPresetMap,
  parseCustomPresets,
} from './schema.js';

export type PresetFamily = 'image' | 'video' | 'audio' | 'pdf' | 'office';
export type PresetDelivery = 'legacy' | 'versions' | 'transform';

export interface PresetOutput {
  version: string;
  operations: AssetTransformOperation[];
}

export interface NamedPreset {
  name: string;
  families: PresetFamily[];
  source: 'builtin' | 'custom';
  /** `legacy` keeps the original web-optimized processors. */
  delivery: PresetDelivery;
  outputs: PresetOutput[];
}

export interface PresetSummary {
  name: string;
  families: PresetFamily[];
  source: 'builtin' | 'custom';
  delivery: PresetDelivery;
  versions: string[];
}

const imageResize = (
  version: string,
  width: number,
  height?: number,
  fit: 'cover' | 'contain' = 'contain',
): PresetOutput => ({
  version,
  operations: [
    {
      op: 'image.resize',
      width,
      ...(height ? { height } : {}),
      fit,
    },
  ],
});

export const BUILTIN_PRESETS: NamedPreset[] = [
  {
    name: 'web-optimized',
    families: ['image', 'video', 'audio'],
    source: 'builtin',
    delivery: 'legacy',
    outputs: [
      imageResize('thumbnail', 320),
      imageResize('optimized', 1280),
      imageResize('hd', 1920),
    ],
  },
  {
    name: 'thumbnail',
    families: ['image'],
    source: 'builtin',
    delivery: 'transform',
    outputs: [imageResize('thumbnail', 320)],
  },
  {
    name: 'avatar',
    families: ['image'],
    source: 'builtin',
    delivery: 'transform',
    outputs: [imageResize('avatar', 512, 512, 'cover')],
  },
  {
    name: 'og-image',
    families: ['image'],
    source: 'builtin',
    delivery: 'transform',
    outputs: [imageResize('og', 1200, 630, 'cover')],
  },
  {
    name: 'hero',
    families: ['image'],
    source: 'builtin',
    delivery: 'transform',
    outputs: [imageResize('hero', 1920)],
  },
  {
    name: 'social-square',
    families: ['image'],
    source: 'builtin',
    delivery: 'transform',
    outputs: [imageResize('square', 1080, 1080, 'cover')],
  },
  {
    name: 'video-480p',
    families: ['video'],
    source: 'builtin',
    delivery: 'transform',
    outputs: [
      { version: '480p', operations: [{ op: 'video.resize', height: 480 }] },
    ],
  },
  {
    name: 'video-720p',
    families: ['video'],
    source: 'builtin',
    delivery: 'transform',
    outputs: [
      { version: '720p', operations: [{ op: 'video.resize', height: 720 }] },
    ],
  },
  {
    name: 'video-1080p',
    families: ['video'],
    source: 'builtin',
    delivery: 'transform',
    outputs: [
      {
        version: '1080p',
        operations: [{ op: 'video.resize', height: 1080 }],
      },
    ],
  },
  {
    name: 'video-preview',
    families: ['video'],
    source: 'builtin',
    delivery: 'transform',
    outputs: [
      {
        version: 'preview',
        operations: [
          { op: 'video.trim', startMs: 0, endMs: 5000 },
          { op: 'video.resize', height: 480 },
        ],
      },
    ],
  },
  {
    name: 'poster',
    families: ['video'],
    source: 'builtin',
    delivery: 'versions',
    outputs: [
      {
        version: 'poster',
        operations: [{ op: 'video.poster', atMs: 0, width: 1280 }],
      },
    ],
  },
  {
    name: 'thumbnails',
    families: ['video'],
    source: 'builtin',
    delivery: 'versions',
    outputs: [
      {
        version: 'thumb',
        operations: [{ op: 'video.thumbnails', count: 4, width: 160 }],
      },
    ],
  },
  {
    name: 'sprites',
    families: ['video'],
    source: 'builtin',
    delivery: 'versions',
    outputs: [
      {
        version: 'sprite',
        operations: [
          { op: 'video.sprite', columns: 4, rows: 2, cellWidth: 80 },
        ],
      },
    ],
  },
  {
    name: 'pdf-pages',
    families: ['pdf'],
    source: 'builtin',
    delivery: 'versions',
    outputs: [
      {
        version: 'page',
        operations: [{ op: 'pdf.pages', format: 'png', dpi: 72, width: 640 }],
      },
    ],
  },
  {
    name: 'pdf-text',
    families: ['pdf'],
    source: 'builtin',
    delivery: 'versions',
    outputs: [
      {
        version: 'text',
        operations: [{ op: 'pdf.text' }],
      },
    ],
  },
  {
    name: 'pdf-cover',
    families: ['pdf'],
    source: 'builtin',
    delivery: 'versions',
    outputs: [
      {
        version: 'page',
        operations: [
          { op: 'pdf.pages', pages: [1], format: 'webp', dpi: 72, width: 800 },
        ],
      },
    ],
  },
  {
    name: 'office-pdf',
    families: ['office'],
    source: 'builtin',
    delivery: 'versions',
    outputs: [
      {
        version: 'pdf',
        operations: [{ op: 'office.toPdf' }],
      },
    ],
  },
];

const BUILTIN_NAMES = new Set(BUILTIN_PRESETS.map((preset) => preset.name));

export function customPresetMap(value: unknown): CustomPresetMap {
  return parseCustomPresets(value, BUILTIN_NAMES);
}

export function findPreset(
  name: string,
  custom: CustomPresetMap = {},
): NamedPreset | undefined {
  const builtin = BUILTIN_PRESETS.find((preset) => preset.name === name);
  if (builtin) return builtin;
  const extra = custom[name];
  if (!extra) return undefined;
  return customToNamed(name, extra);
}

export function listPresets(custom: CustomPresetMap = {}): PresetSummary[] {
  const builtins = BUILTIN_PRESETS.map(summarize);
  const extras = Object.entries(custom).map(([name, preset]) =>
    summarize(customToNamed(name, preset)),
  );
  return [...builtins, ...extras];
}

export function presetNamesFor(
  family: PresetFamily | 'pdf' | 'other',
  custom: CustomPresetMap = {},
): string[] {
  return listPresets(custom)
    .filter((preset) => preset.families.includes(family as PresetFamily))
    .map((preset) => preset.name);
}

function customToNamed(name: string, preset: CustomPreset): NamedPreset {
  const poster = preset.operations.some(
    (operation) =>
      isFrameOperation(operation.op) ||
      operation.op === 'pdf.pages' ||
      operation.op === 'pdf.text' ||
      operation.op === 'office.toPdf',
  );
  return {
    name,
    families: [preset.family],
    source: 'custom',
    delivery: poster ? 'versions' : 'transform',
    outputs: [{ version: preset.version, operations: preset.operations }],
  };
}

function summarize(preset: NamedPreset): PresetSummary {
  return {
    name: preset.name,
    families: preset.families,
    source: preset.source,
    delivery: preset.delivery,
    versions: preset.outputs.map((output) => output.version),
  };
}
