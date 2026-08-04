import { Type, type TSchema } from "typebox";

export interface OpenAIGrammarSampling {
  type: "grammar";
  variants: { openai_lark: string };
}

/** Create the OpenAI grammar transport used by Responses custom tools. */
export function createOpenAILarkSampling(definition: string): OpenAIGrammarSampling {
  if (definition.trim().length === 0) {
    throw new Error("OpenAI Lark grammar cannot be empty.");
  }
  return { type: "grammar", variants: { openai_lark: definition } };
}

/** Build the one-required-string schema Pi uses to identify raw custom-tool input. */
export function createFreeformInputSchema(inputProperty: string, description: string): TSchema {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(inputProperty) || inputProperty === "__proto__") {
    throw new Error(`Invalid freeform input property: ${inputProperty}`);
  }

  const properties: Record<string, TSchema> = Object.create(null) as Record<string, TSchema>;
  properties[inputProperty] = Type.String({ description });
  return Type.Object(properties, { additionalProperties: false });
}
