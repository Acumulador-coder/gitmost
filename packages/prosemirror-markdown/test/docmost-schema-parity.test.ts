import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { documentExtensions } from '@docmost/editor-ext';
import {
  docmostExtensions,
  OVERRIDE_EXTENSION_NAMES,
} from '../src/lib/docmost-schema.js';

// TP-3: the converter schema is editor-ext's `documentExtensions` with only
// parse rules and defaults patched (OVERRIDES). A patch must never add, drop or
// rename an attribute: an attribute only the converter knows would be cut by
// the editor schema on save (the #684 data-loss class), and an override whose
// extension was renamed in editor-ext would silently stop applying.

const attrNames = (spec: { attrs?: Record<string, unknown> } | undefined) =>
  Object.keys(spec?.attrs ?? {}).sort();

describe('converter schema parity with editor-ext documentExtensions', () => {
  const editor = getSchema(documentExtensions as any[]);
  const converter = getSchema(docmostExtensions as any[]);

  it('has the same nodes and marks', () => {
    expect(Object.keys(converter.nodes).sort()).toEqual(
      Object.keys(editor.nodes).sort(),
    );
    expect(Object.keys(converter.marks).sort()).toEqual(
      Object.keys(editor.marks).sort(),
    );
  });

  it('every node has the same attribute names', () => {
    for (const name of Object.keys(editor.nodes)) {
      expect({ node: name, attrs: attrNames(converter.nodes[name]?.spec) }).toEqual({
        node: name,
        attrs: attrNames(editor.nodes[name].spec),
      });
    }
  });

  it('every mark has the same attribute names', () => {
    for (const name of Object.keys(editor.marks)) {
      expect({ mark: name, attrs: attrNames(converter.marks[name]?.spec) }).toEqual({
        mark: name,
        attrs: attrNames(editor.marks[name].spec),
      });
    }
  });

  it('every OVERRIDES key names an extension in documentExtensions', () => {
    const names = new Set((documentExtensions as any[]).map((ext) => ext.name));
    expect(OVERRIDE_EXTENSION_NAMES.length).toBeGreaterThan(0);
    expect(OVERRIDE_EXTENSION_NAMES.filter((key) => !names.has(key))).toEqual([]);
  });
});
