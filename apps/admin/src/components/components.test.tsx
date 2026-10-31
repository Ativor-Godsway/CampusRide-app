/**
 * The building blocks render honest states: loading, empty and error;
 * "—" (not 0%) when there's no number; a word on every chip; charts with a
 * text summary for screen readers.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Chip } from "./Chip";
import { DataTable } from "./DataTable";
import { StatTile } from "./StatTile";
import { Loaded } from "./States";
import { HeatGrid } from "../charts/HeatGrid";
import { PairedBars } from "../charts/PairedBars";
import { BarList } from "../charts/BarList";

const cols = [{ key: "n", header: "Name", render: (r: { n: string }) => r.n, sortValue: (r: { n: string }) => r.n }];

describe("states", () => {
  it("Loaded shows loading, then an error with a retry, then the content", () => {
    expect(renderToStaticMarkup(<Loaded data={null} error={null} loading what="Loading today…">{() => "x"}</Loaded>)).toContain("Loading today…");
    const failed = renderToStaticMarkup(<Loaded data={null} error="Could not reach the API" loading={false} onRetry={() => {}}>{() => "x"}</Loaded>);
    expect(failed).toContain("Could not reach the API");
    expect(failed).toContain("Try again");
    expect(failed).toContain('role="alert"');
    const stale = renderToStaticMarkup(<Loaded data={{ n: 1 }} error="timeout" loading={false}>{(d) => `value ${d.n}`}</Loaded>);
    expect(stale).toContain("value 1");
    expect(stale).toContain("Couldn&#x27;t refresh");
  });

  it("DataTable: loading, error, empty, rows with a sortable header and labelled cells", () => {
    expect(renderToStaticMarkup(<DataTable columns={cols} rows={null} rowKey={(r) => r.n} loading />)).toContain("Loading");
    expect(renderToStaticMarkup(<DataTable columns={cols} rows={null} rowKey={(r) => r.n} error="Server error" />)).toContain("Server error");
    expect(renderToStaticMarkup(<DataTable columns={cols} rows={[]} rowKey={(r) => r.n} empty="No rides yet." />)).toContain("No rides yet.");
    const html = renderToStaticMarkup(<DataTable columns={cols} rows={[{ n: "Ama" }, { n: "Yaw" }]} rowKey={(r) => r.n} onRowClick={() => {}} rowLabel={(r) => `Open ${r.n}`} />);
    expect(html).toContain('data-label="Name"');
    expect(html).toContain('<button type="button" class="sort-button">Name');
    expect(html).toContain('aria-label="Open Ama"');
    expect(html).toContain('tabindex="0"');
  });

  it("DataTable pages its rows", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ n: `r${i}` }));
    const html = renderToStaticMarkup(<DataTable columns={cols} rows={rows} rowKey={(r) => r.n} pageSize={25} />);
    expect(html).toContain("Page 1 of 2");
    expect(html).not.toContain(">r29<");
  });
});

describe("tiles and chips", () => {
  it("a tile with no number says — and why, never 0%", () => {
    const html = renderToStaticMarkup(<StatTile label="Got a driver" value={null} />);
    expect(html).toContain("—");
    expect(html).toContain("Not enough data yet");
  });
  it("a chip is a word, coloured by its tone", () => {
    expect(renderToStaticMarkup(<Chip tone="red">Not paid</Chip>)).toBe('<span class="chip chip-red">Not paid</span>');
  });
});

describe("charts", () => {
  it("paired bars carry a summary and a title per bar", () => {
    const html = renderToStaticMarkup(
      <PairedBars series={[{ label: "Requests", color: "green", values: [1, 4] }, { label: "Drivers online", color: "amber", values: [2, 0] }]} labels={["5", "6 pm"]} summary="Busiest at 6 pm" />,
    );
    expect(html).toContain('aria-label="Busiest at 6 pm"');
    expect(html).toContain("<title>6 pm: 4 requests</title>");
    expect(html).toContain("Drivers online");
  });
  it("the heat grid names its levels in words and each cell's count", () => {
    const values = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    values[4]![17] = 3;
    const html = renderToStaticMarkup(<HeatGrid values={values} hours={[17, 18]} hourLabels={["5 pm", "6"]} what="unanswered" summary="No-driver requests" />);
    expect(html).toContain('title="Fri 5 pm: 3 unanswered (the most)"');
    expect(html).toContain('title="Mon 5 pm: 0 unanswered (none)"');
    expect(html).toContain("More unanswered");
  });
  it("bar lists show the number beside each bar", () => {
    const html = renderToStaticMarkup(<BarList items={[{ label: "Price", value: 3 }]} summary="Reasons" />);
    expect(html).toContain("Price");
    expect(html).toContain(">3<");
  });
});
