import { analyzeChange, preflight, simulateChange, traceImpact, type ReflexReport, type ReflexHost } from "../src/index";
import { fixture, response } from "./fixtures";

const { snapshot, change } = fixture();
let latest = simulateChange(snapshot, change);
let selected = "action:website";
let runId = 0;
const el = <T extends HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error("Demo element missing");
  return found as T;
};
const human = (status: string) => ({ needs_revalidation: "Revalidate", unknown: "Uncertain", no_change_detected: "No change detected", revalidate: "Revalidate", unexamined: "Unexamined" })[status] ?? status;
const short = (id: string) => id.split(":")[1] ?? id;

function render(report: ReflexReport) {
  latest = report;
  const impacts = new Map(report.impacts.map((impact) => [impact.node_id, impact]));
  const isScenario = report.mode === "counterfactual";
  el("mode-label").textContent = isScenario ? "COUNTERFACTUAL · NO MODEL" : "SCRIPTED REHEARSAL · NOT LIVE JEV";
  el("report-status").textContent = report.status.toUpperCase();
  el("stat-impacts").textContent = String(report.impacts.length);
  el("stat-actions").textContent = String(report.impacts.filter((impact) => impact.kind === "action").length);
  el("stat-questions").textContent = String(report.metrics.questions_started);
  el("stat-io").textContent = "0";
  el("judgment").textContent = isScenario ? "Assume the classifier architecture changed." :
    report.judgments[0]?.effect === "needs_revalidation" ? "The scripted answers support a change." :
    report.status === "stale" ? "The source-policy epoch changed. All conclusions were discarded." :
    report.status === "incomplete" ? "The evidence is unresolved. No action is cleared." : "The scripted answers detect no change.";
  for (const node of snapshot.nodes) {
    const button = document.querySelector<HTMLButtonElement>(`[data-node="${node.id}"]`)!;
    const impact = impacts.get(node.id);
    button.dataset.effect = impact?.effect ?? "no_change_detected";
    button.setAttribute("aria-pressed", String(selected === node.id));
    button.querySelector(".node-status")!.textContent = human(impact?.effect ?? "no_change_detected");
  }
  const steps = preflight(report, snapshot.binding, [
    { id: "publish-website", assumptions: [{ node_id: "action:website", revision: "r4" }] },
    { id: "enable-classifier", assumptions: [{ node_id: "action:enable", revision: "r5" }] },
    { id: "local-typecheck", assumptions: [{ node_id: "action:lint", revision: "r6" }] },
  ]).steps;
  const container = el("plan-steps");
  container.replaceChildren();
  for (const [index, step] of steps.entries()) {
    const row = document.createElement("div"); row.className = "plan-step";
    const number = document.createElement("span"); number.className = "step-number"; number.textContent = `0${index + 1}`;
    const label = document.createElement("span"); label.textContent = ({ "publish-website": "Publish launch page", "enable-classifier": "Enable classifier", "local-typecheck": "Run local typecheck" })[step.step_id] ?? step.step_id;
    const status = document.createElement("span"); status.className = "badge"; status.dataset.status = step.status; status.textContent = human(step.status);
    row.append(number, label, status); container.append(row);
  }
  detail();
  requestAnimationFrame(drawEdges);
}
function detail() {
  const node = snapshot.nodes.find((node) => node.id === selected)!;
  const impact = latest.impacts.find((impact) => impact.node_id === selected);
  el("detail-title").textContent = node.statement;
  el("detail-kind").textContent = `${node.kind.toUpperCase()} · ${node.revision}`;
  el("detail-status").textContent = human(impact?.effect ?? "no_change_detected");
  const trace = traceImpact(snapshot, change, "fact:local", selected);
  el("trace-path").textContent = trace.nodes.length ? trace.nodes.map(short).join(" → ") : "No dependency path from this change.";
  const sources = el("evidence"); sources.replaceChildren();
  for (const source of trace.evidence_ids) {
    const label = document.createElement("code"); label.textContent = source; sources.append(label);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-node]")) button.setAttribute("aria-pressed", String(button.dataset.node === selected));
}
function drawEdges() {
  const canvas = el("graph");
  const svg = document.getElementById("edges")!;
  const rect = canvas.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  svg.replaceChildren();
  for (const edge of snapshot.dependencies) {
    const from = document.querySelector<HTMLElement>(`[data-node="${edge.prerequisite}"]`)!.getBoundingClientRect();
    const to = document.querySelector<HTMLElement>(`[data-node="${edge.dependent}"]`)!.getBoundingClientRect();
    const mobile = window.innerWidth < 680;
    const x1 = (mobile ? from.left + from.width / 2 : from.right) - rect.left;
    const y1 = (mobile ? from.bottom : from.top + from.height / 2) - rect.top;
    const x2 = (mobile ? to.left + to.width / 2 : to.left) - rect.left;
    const y2 = (mobile ? to.top : to.top + to.height / 2) - rect.top;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", mobile ? `M${x1},${y1} C${x1 - 25},${y1 + 15} ${x2 - 25},${y2 - 15} ${x2},${y2}` :
      `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`);
    path.classList.add("edge");
    path.classList.toggle("active", latest.impacts.some((impact) => impact.node_id === edge.dependent));
    svg.append(path);
  }
}
async function run() {
  const version = ++runId;
  const mode = el<HTMLSelectElement>("scenario").value;
  el<HTMLButtonElement>("run").disabled = true;
  el("run").textContent = "Evaluating…";
  try {
    if (mode === "scenario") render(simulateChange(snapshot, change));
    else {
      let current = true;
      const host: ReflexHost = {
        async isCurrent() { return current; },
        async evaluateAuthorized() {
          if (mode === "unavailable") throw new Error("Synthetic unavailable port");
          if (mode === "revoked") current = false;
          const result = response(mode === "supports" ? "supports" : "contradicts");
          if (mode === "ambiguous") return { ...result, answers: { ...result.answers, counterevidence: { type: "noul", noul: 0.9 } } };
          return result;
        },
      };
      const report = await analyzeChange(snapshot, change, { host });
      if (version === runId) render(report);
    }
  } finally {
    if (version === runId) { el<HTMLButtonElement>("run").disabled = false; el("run").textContent = "Run analysis →"; }
  }
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-node]")) button.addEventListener("click", () => { selected = button.dataset.node!; detail(); });
el("run").addEventListener("click", () => { void run(); });
el("scenario").addEventListener("change", () => { void run(); });
el("export").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ disclaimer: "Synthetic offline demonstration; no live Jev evaluation or authorization.", report: latest }, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "kizuki-reflex-synthetic-report.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("resize", drawEdges);
render(latest);
