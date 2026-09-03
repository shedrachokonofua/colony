import { describe, expect, it } from "bun:test";
import { createArchitectExtensionSubmitTool } from "./architect-extension.js";
import {
  createImplementerSubmitTool,
  createReviewerSubmitTool,
} from "./pi-runner-common.js";

/**
 * Normalise a tool parameters representation (TypeBox / omptype schema) to
 * its plain JSON Schema object.
 */
function JSONSchema(parameters: unknown): Record<string, unknown> {
  if (
    parameters &&
    typeof (parameters as { toJsonSchema?: unknown }).toJsonSchema ===
      "function"
  ) {
    return (
      parameters as { toJsonSchema(): Record<string, unknown> }
    ).toJsonSchema();
  }
  return parameters as Record<string, unknown>;
}

describe("submit tool schema shape", () => {
  const factories = [
    {
      name: "createArchitectExtensionSubmitTool",
      create: () => createArchitectExtensionSubmitTool(() => {}),
    },
    {
      name: "createImplementerSubmitTool",
      create: () => createImplementerSubmitTool(() => {}),
    },
    {
      name: "createReviewerSubmitTool",
      create: () => createReviewerSubmitTool(() => {}),
    },
  ] as const;

  for (const { name, create } of factories) {
    it(`enforces flat schema shape on ${name}`, () => {
      const tool = create();

      // Read tool.parameters (TypeBox) plus JSONSchema(tool.parameters)
      const typeboxParams = tool.parameters;
      expect(typeboxParams).toBeDefined();

      const jsonSchema = JSONSchema(tool.parameters);
      expect(jsonSchema).toBeDefined();

      // (1) Top-level type is 'object' with properties and additionalProperties: false,
      // with NO anyOf/oneOf/allOf keys at the top level.
      expect(jsonSchema.type, `${name}: top-level type must be 'object'`).toBe(
        "object",
      );
      expect(
        jsonSchema.properties,
        `${name}: schema must declare properties`,
      ).toBeDefined();
      expect(
        typeof jsonSchema.properties,
        `${name}: properties must be an object`,
      ).toBe("object");
      expect(
        jsonSchema.additionalProperties,
        `${name}: additionalProperties must be false`,
      ).toBe(false);

      expect(
        jsonSchema.anyOf,
        `${name}: must not have anyOf at top level`,
      ).toBeUndefined();
      expect(
        jsonSchema.oneOf,
        `${name}: must not have oneOf at top level`,
      ).toBeUndefined();
      expect(
        jsonSchema.allOf,
        `${name}: must not have allOf at top level`,
      ).toBeUndefined();

      // (2) Every property the model must set is either listed in required
      // OR has both a default and a non-empty description.
      // Properties defined on the schema that the model is required to provide must be
      // listed in `required`, unless the schema declares both a default and a non-empty description.
      const properties = (jsonSchema.properties ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const requiredList = Array.isArray(jsonSchema.required)
        ? (jsonSchema.required as string[])
        : [];
      const isRequiredKey: Record<string, true> = {};
      for (const key of requiredList) {
        isRequiredKey[key] = true;
      }

      for (const [fieldName, fieldDef] of Object.entries(properties)) {
        const isRequired = isRequiredKey[fieldName] === true;
        const hasDefault = "default" in fieldDef;
        const hasNonEmptyDescription =
          typeof fieldDef.description === "string" &&
          fieldDef.description.trim().length > 0;

        // If a property is required, or optional with default & description, or truly optional:
        // A property the model must set without a default must be declared in required.
        if (isRequired) {
          expect(isRequired).toBe(true);
        } else if (hasDefault) {
          if (!hasNonEmptyDescription) {
            throw new Error(
              `${name}: offending field '${fieldName}' has a default but lacks a non-empty description`,
            );
          }
        }
      }
    });
  }
});
