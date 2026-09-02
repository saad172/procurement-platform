import type { ComponentType } from 'react';
import type { Widget, WidgetType } from '@/tools/define';
import { CategorySummaryWidget } from './category-summary';
import { CriterionCompareWidget } from './criterion-compare';
import { EntityCardWidget } from './entity-card';
import { LeadTableWidget } from './lead-table';
import { NeedsReviewListWidget } from './needs-review-list';
import { ProgramSummaryWidget } from './program-summary';
import { RawPayload } from './raw';
import { RecordCardWidget } from './record-card';
import { ShortlistTableWidget } from './shortlist-table';
import { SourceResultWidget } from './source-result';
import { SupplierCardWidget } from './supplier-card';
import { SupplierFamilyWidget } from './supplier-family';
import { TraceTimelineWidget } from './trace-timeline';
import { UsageMeterWidget } from './usage-meter';

/**
 * One renderer per widget type, named after the tool and never after the
 * shape (SPEC §14.4). A widget is a read tool's return value frozen onto the
 * message, so what is drawn here came from a row and never from the model's
 * typing — which is the whole reason chat may show a figure at all.
 *
 * The map is keyed by the closed `WidgetType` union, so adding a fourteenth
 * type without a renderer is a type error, not a blank card.
 *
 * **Two different guards protect two different things, and every renderer
 * picks one.** `widget.type` is a Postgres enum column, written once by
 * `widget()` and never by anything else, so `RenderWidget` below trusts it
 * outright. What a renderer cannot trust is the PAYLOAD *inside* that type: a
 * message frozen months ago can carry a shape this file's own tool has since
 * changed. Where the tool's projection is a stable, declared shape (most
 * reads), the widget owns a `zod` schema and calls `safeParse`. Where the
 * payload is a raw database row a tool hands over whole (`supplier_card`,
 * `entity_card`, `record_card`, `supplier_family`, `source_result`,
 * `trace_timeline`, `usage_meter`), a schema would just restate the table, so
 * the widget hand-narrows with `narrow.ts`'s predicates instead. Both paths
 * end the same way: a mismatch falls back to `RawPayload`, never a throw.
 */
const RENDERERS: Record<WidgetType, ComponentType<{ payload: unknown }>> = {
  program_summary: ProgramSummaryWidget,
  category_summary: CategorySummaryWidget,
  supplier_card: SupplierCardWidget,
  supplier_family: SupplierFamilyWidget,
  entity_card: EntityCardWidget,
  record_card: RecordCardWidget,
  shortlist_table: ShortlistTableWidget,
  criterion_compare: CriterionCompareWidget,
  trace_timeline: TraceTimelineWidget,
  needs_review_list: NeedsReviewListWidget,
  lead_table: LeadTableWidget,
  usage_meter: UsageMeterWidget,
  source_result: SourceResultWidget,
};

/**
 * A tool call renders as one collapsed chip expanding on click, with the
 * widget expanded by default (SPEC §14.7). The chip carries the tool's name
 * and the widget's; under it is the raw frozen payload, because the working
 * is demoted, never hidden.
 */
export function RenderWidget({ toolName, widget }: { toolName: string; widget: Widget }) {
  // `widget.type` is a `WidgetType`, and `RENDERERS` is a `Record` over the
  // whole closed union — this lookup cannot miss, so it is never cast and
  // never falls back to `RawPayload` the way a mismatched PAYLOAD does below.
  const Renderer = RENDERERS[widget.type];
  return (
    <div className="card" style={{ marginTop: '0.4rem', padding: '0.5rem 0.7rem' }}>
      <Renderer payload={widget.payload} />
      <details className="working" style={{ margin: '0.5rem 0 0', padding: '0.2rem 0.5rem' }}>
        <summary className="note">
          {toolName} · {widget.type}
        </summary>
        <RawPayload payload={widget.payload} />
      </details>
    </div>
  );
}
