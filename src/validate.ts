// Build-time content validation shared by the data/ and plugins/ loaders.
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

/** Validate `value` against `schema`, failing fast with the file location. */
export function validate<S extends z.ZodType>(
  schema: S,
  value: unknown,
  where: string
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid content in ${where}: ${issues}`);
  }
  return result.data;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Split a markdown file into validated YAML frontmatter and its body. */
export function parseMarkdown<S extends z.ZodType>(
  schema: S,
  text: string,
  where: string
): { meta: z.infer<S>; body: string } {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) throw new Error(`Missing YAML frontmatter in ${where}`);
  let raw: unknown;
  try {
    raw = parseYaml(match[1]);
  } catch (e) {
    throw new Error(
      `Invalid YAML frontmatter in ${where}: ${(e as Error).message}`
    );
  }
  const body = match[2].trim();
  if (!body) throw new Error(`Empty body in ${where}`);
  return { meta: validate(schema, raw ?? {}, where), body };
}
