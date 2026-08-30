/**
 * A guard for the tools that take a database id.
 *
 * ## The failure it replaces
 *
 * A resolve Round called `get_supplier` with `{ supplierId: "Yazaki" }`. The
 * roster name is what a person would say, and it is the first thing the prompt
 * puts in front of the model — so reaching for it is the natural mistake, not a
 * careless one.
 *
 * Postgres answered `invalid input syntax for type uuid`, which **threw** out of
 * the handler. Two things went wrong at once: the model was told a database
 * error instead of what to do, and the throw skipped the Trace row entirely, so
 * the call recorded no outcome at all.
 *
 * ## Why an objection rather than a lookup
 *
 * `get_supplier` could have accepted a name. It should not: `find_supplier_by_name`
 * already exists, and a tool that quietly accepts two kinds of key makes the
 * Trace ambiguous about which one was used. A handler returning objections
 * renders as a **visible block, verbatim**, and the model adjusts rather than
 * retrying blind — so naming the other tool costs one turn and teaches the
 * right path.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDatabaseId(value: string): boolean {
  return UUID.test(value);
}

/**
 * The objection for a value that is not an id, naming the tool that finds one.
 *
 * `hint` is the tool to use instead, because "that is not a valid id" without a
 * next step is a dead end the model can only guess its way out of.
 */
export function notAnIdObjection(field: string, value: string, hint: string): string {
  return (
    `"${value}" is not a ${field} — those are database ids, not names. ` +
    `Use ${hint} to find the id first.`
  );
}
