// Sanity-check the PWA manifest. DESIGN.md §15.5 lists "Manifest validates"
// as a required test; this exercises the structural fields the install path
// actually cares about. A full schema validator isn't worth pulling in.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(
  new URL('../../public/manifest.webmanifest', import.meta.url),
);

describe('manifest.webmanifest', () => {
  const raw = readFileSync(manifestPath, 'utf8');
  const json = JSON.parse(raw) as Record<string, unknown>;

  it('parses as JSON', () => {
    expect(typeof json).toBe('object');
  });

  it('declares the fields browsers require for install', () => {
    expect(json.name).toBe('Jamboree');
    expect(json.short_name).toBe('Jamboree');
    expect(json.start_url).toBeTypeOf('string');
    expect(json.scope).toBeTypeOf('string');
    expect(json.display).toBe('standalone');
    expect(json.theme_color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(json.background_color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
  });

  it('lists at least one regular and one maskable icon', () => {
    const icons = json.icons as Array<{
      src: string;
      type: string;
      purpose?: string;
    }>;
    expect(Array.isArray(icons)).toBe(true);
    expect(icons.some((i) => (i.purpose ?? 'any').includes('any'))).toBe(true);
    expect(icons.some((i) => (i.purpose ?? '').includes('maskable'))).toBe(true);
    for (const icon of icons) {
      expect(icon.src).toBeTypeOf('string');
      expect(icon.type).toBeTypeOf('string');
    }
  });
});
