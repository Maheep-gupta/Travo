// Maps validation issues to the form field they belong to, so each message can
// be attached to its input (aria-invalid + aria-describedby). Structural only:
// no dependency on zod, so it works with any validator that reports paths.

export interface ValidationIssue {
  path: readonly PropertyKey[];
  message: string;
}

export type FieldErrors<F extends string> = Partial<Record<F | "form", string>>;

/** First message per field; issues for unknown or missing paths become a form-level error. */
export function fieldErrors<F extends string>(issues: readonly ValidationIssue[], fields: readonly F[]): FieldErrors<F> {
  const out: FieldErrors<F> = {};
  for (const issue of issues) {
    const head = issue.path[0];
    const key = typeof head === "string" && (fields as readonly string[]).includes(head) ? (head as F) : "form";
    out[key] ??= issue.message;
  }
  return out;
}

/** The first field (in form order) that has an error, for moving focus after a rejected submit. */
export function firstInvalidField<F extends string>(errors: FieldErrors<F>, fields: readonly F[]): F | null {
  return fields.find((f) => errors[f] !== undefined) ?? null;
}
