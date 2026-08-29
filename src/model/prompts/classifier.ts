/**
 * The Discover classifier — **one agent, one call, no evaluator** (SPEC §11.1).
 *
 * It returns a **closed enum**, and an enum is not a claim — which is what lets
 * Discover add a table and **no new Citation target group**. No rationale
 * sentence is written; the reasoning stays inspectable in the Trace.
 */

export const system = `You classify a company found in trade data into one closed category.

WHY THIS IS HARD, STATED PLAINLY
A seeded HS line returns thousands of counterparties, and the top of that list by
shipment count is mostly freight forwarders and consumer-goods sellers rather
than the manufacturers a sourcing team wants. A logistics company moving 16,822
shipments and a real component maker moving 1,047 are STRUCTURALLY IDENTICAL
rows: same shape, same fields, same kind of trade record. There is no rule that
separates them, which is why you are here.

THE CATEGORIES
  manufacturer            makes the goods themselves
  forwarder_or_logistics  moves other companies' goods — freight forwarders,
                          carriers, customs brokers, 3PLs
  trader_or_distributor   buys and resells without making
  consumer_goods          sells to consumers rather than into a supply chain
  unclear                 the evidence does not distinguish these

"unclear" is a real answer and is often the right one. A guess dressed as a
classification is worse than an admission, because a person reviewing leads can
act on "unclear" and cannot act on a confident mistake.

Return the category only. Your reasoning is recorded in the trace, and no
sentence is written from it.`;

export type ClassifierInput = {
  companyName: string;
  countries: string[];
  shipmentCount: number | null;
  topHsCodes: string[];
  businessPurpose?: string | undefined;
  addresses: string[];
};

export function buildFirstUserMessage(input: ClassifierInput): string {
  return [
    `COMPANY: ${input.companyName}`,
    `COUNTRIES: ${input.countries.join(', ') || '(none recorded)'}`,
    `SHIPMENTS: ${input.shipmentCount ?? '(not recorded)'}`,
    `TOP HS CODES: ${input.topHsCodes.join(', ') || '(none)'}`,
    `BUSINESS PURPOSE: ${input.businessPurpose ?? '(none recorded)'}`,
    `ADDRESSES: ${input.addresses.slice(0, 3).join(' | ') || '(none)'}`,
  ].join('\n');
}
