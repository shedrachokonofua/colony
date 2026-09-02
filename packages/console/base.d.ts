// Type surface of the buildless console's lit base module. The .js imports
// lit through the page's import map (vendored, minified); these declarations
// give tsc (checkJs) the real lit types so element subclasses type-check.
// Kept in sync with base.js by hand — it re-exports exactly these.
import { LitElement, TemplateResult } from "lit";
import { ClassInfo } from "lit-html/directives/class-map.js";
import { DirectiveChild } from "lit-html/directive.js";

export declare class ColonyElement extends LitElement {
  createRenderRoot(): ColonyElement;
}

export declare const html: (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => TemplateResult;

export declare const svg: (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => TemplateResult;

export declare const nothing: DirectiveChild;

export declare function classMap(classInfo: ClassInfo): unknown;

export declare function repeat<T>(
  items: Iterable<T>,
  keyFn: (item: T, index: number) => unknown,
  template: (item: T, index: number) => DirectiveChild,
): DirectiveChild;
export declare function live(value: unknown): unknown;
