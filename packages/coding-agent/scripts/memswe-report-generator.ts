#!/usr/bin/env -S npx tsx

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const RUNS_ROOT = join(REPO_ROOT, ".memswe-runs");
const REPORTS_ROOT = join(RUNS_ROOT, "reports");

type JsonObject = Record<string, unknown>;

type VerifierSummary = {
	id: string;
	kind: string;
	exitCode: number | null;
	status: "passed" | "failed" | "skipped";
};

type RunSummary = {
	runId: string;
	timestamp: string;
	taskId: string;
	conditionId: string;
	modelId: string;
	memorySystem: string | null;
	reward: number | null;
	status: string;
	sessionId: string | null;
	agentMode: string | null;
	providerModel: string | null;
	baseUrl: string | null;
	eventCount: number | null;
	messageCount: number | null;
	error: string | null;
	visiblePassed: number;
	visibleTotal: number;
	protectedPassed: number;
	protectedTotal: number;
	hiddenSkipped: number;
	changedFiles: number;
	verifiers: VerifierSummary[];
	artifactPath: string;
	agentResultPath: string | null;
	finalResponsePreview: string | null;
};

type SuiteTaskSummary = {
	taskId: string;
	status: string;
	failedPhase: string | null;
	error: string | null;
	runRecord: string | null;
};

type SuiteSummary = {
	timestamp: string;
	artifactPath: string;
	passed: number;
	failed: number;
	tasks: SuiteTaskSummary[];
};

type HindsightSummary = {
	timestamp: string;
	artifactPath: string;
	status: string;
	bankId: string | null;
	apiUrl: string | null;
	traceEvents: number;
	retainVisible: boolean | null;
	recallMentionsGammaFact: boolean | null;
	deleteClearedBank: boolean | null;
	error: string | null;
};

type ReviewSummary = {
	name: string;
	artifactPath: string;
	model: string | null;
	verdict: string | null;
	confidence: string | null;
	summary: string | null;
	notes: string[];
};

type ReportData = {
	generatedAt: string;
	runs: RunSummary[];
	suites: SuiteSummary[];
	hindsight: HindsightSummary[];
	reviews: ReviewSummary[];
	metrics: {
		totalRuns: number;
		passedRuns: number;
		failedRuns: number;
		realModelRuns: number;
		fauxRuns: number;
		hindsightPasses: number;
		tasks: number;
		conditions: number;
	};
};

async function pathExists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

async function walkFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const paths = await Promise.all(
		entries.map(async (entry) => {
			const path = join(root, entry.name);
			if (entry.isDirectory()) return walkFiles(path);
			if (entry.isFile()) return [path];
			return [];
		}),
	);
	return paths.flat();
}

async function readJson(path: string): Promise<JsonObject> {
	return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

function objectAt(value: unknown): JsonObject | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function arrayAt(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringAt(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function numberAt(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanAt(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function timestampFromPath(path: string): string {
	const parts = relative(RUNS_ROOT, path).split("/");
	return parts[0] ?? "unknown";
}

function statusFromExit(exitCode: number | null): "passed" | "failed" | "skipped" {
	if (exitCode === null) return "skipped";
	return exitCode === 0 ? "passed" : "failed";
}

async function loadRun(path: string): Promise<RunSummary> {
	const record = await readJson(path);
	const condition = objectAt(record.condition) ?? {};
	const reward = objectAt(record.reward) ?? {};
	const sessions = arrayAt(record.session_results);
	const firstSession = objectAt(sessions[0]) ?? {};
	const artifactPaths = objectAt(firstSession.artifact_paths) ?? {};
	const runDir = dirname(path);
	const verifierPath = join(runDir, "verifier-results.json");
	const agentPath = join(runDir, "agent-result.json");
	const changedFilesPath = join(runDir, "changed-files.json");
	const skippedHiddenPath = join(runDir, "skipped-hidden-verifiers.json");

	const verifierResults = (await pathExists(verifierPath)) ? arrayAt(await readJson(verifierPath)) : [];
	const verifiers = verifierResults.map((entry): VerifierSummary => {
		const obj = objectAt(entry) ?? {};
		const exitCode = numberAt(obj.exit_code);
		return {
			id: stringAt(obj.id) ?? "unknown",
			kind: stringAt(obj.kind) ?? "unknown",
			exitCode,
			status: statusFromExit(exitCode),
		};
	});

	const visible = verifiers.filter((verifier) => verifier.kind === "visible");
	const protectedVerifiers = verifiers.filter((verifier) => verifier.kind === "protected");
	const agent = (await pathExists(agentPath)) ? await readJson(agentPath) : null;
	const changedFiles = (await pathExists(changedFilesPath)) ? arrayAt(await readJson(changedFilesPath)).length : 0;
	const hiddenSkipped = (await pathExists(skippedHiddenPath)) ? arrayAt(await readJson(skippedHiddenPath)).length : 0;
	const providerId = agent ? stringAt(agent.provider_id) : null;
	const modelId = agent ? stringAt(agent.model_id) : null;

	return {
		runId: stringAt(record.run_id) ?? "unknown",
		timestamp: timestampFromPath(path),
		taskId: stringAt(record.task_id) ?? "unknown",
		conditionId: stringAt(condition.condition_id) ?? "unknown",
		modelId: stringAt(condition.model_id) ?? "unknown",
		memorySystem: stringAt(condition.memory_system),
		reward: numberAt(reward.reward),
		status: stringAt(firstSession.status) ?? "unknown",
		sessionId: stringAt(firstSession.session_id),
		agentMode: agent ? stringAt(agent.agent_mode) : null,
		providerModel: providerId && modelId ? `${providerId}/${modelId}` : null,
		baseUrl: agent ? stringAt(agent.base_url) : null,
		eventCount: agent ? numberAt(agent.event_count) : null,
		messageCount: agent ? numberAt(agent.message_count) : null,
		error: agent ? stringAt(agent.error) : null,
		visiblePassed: visible.filter((verifier) => verifier.status === "passed").length,
		visibleTotal: visible.length,
		protectedPassed: protectedVerifiers.filter((verifier) => verifier.status === "passed").length,
		protectedTotal: protectedVerifiers.length,
		hiddenSkipped,
		changedFiles,
		verifiers,
		artifactPath: relative(REPO_ROOT, path),
		agentResultPath: stringAt(artifactPaths.agent_result) ? relative(REPO_ROOT, stringAt(artifactPaths.agent_result)!) : ((await pathExists(agentPath)) ? relative(REPO_ROOT, agentPath) : null),
		finalResponsePreview: agent ? stringAt(agent.final_response)?.slice(0, 320) ?? null : null,
	};
}

async function loadSuite(path: string): Promise<SuiteSummary> {
	const summary = await readJson(path);
	const tasks = arrayAt(summary.task_results).map((entry): SuiteTaskSummary => {
		const obj = objectAt(entry) ?? {};
		return {
			taskId: stringAt(obj.task_id) ?? "unknown",
			status: stringAt(obj.status) ?? "unknown",
			failedPhase: stringAt(obj.failed_phase),
			error: stringAt(obj.error),
			runRecord: stringAt(obj.run_record),
		};
	});
	return {
		timestamp: timestampFromPath(path),
		artifactPath: relative(REPO_ROOT, path),
		passed: tasks.filter((task) => task.status === "passed").length,
		failed: tasks.filter((task) => task.status !== "passed").length,
		tasks,
	};
}

async function loadHindsight(path: string): Promise<HindsightSummary> {
	const smoke = await readJson(path);
	const predicates = objectAt(smoke.predicate_results) ?? {};
	const error = objectAt(smoke.error);
	return {
		timestamp: timestampFromPath(path),
		artifactPath: relative(REPO_ROOT, path),
		status: stringAt(smoke.status) ?? "unknown",
		bankId: stringAt(smoke.bank_id),
		apiUrl: stringAt(smoke.api_url),
		traceEvents: arrayAt(smoke.trace).length,
		retainVisible: booleanAt(predicates.retain_visible),
		recallMentionsGammaFact: booleanAt(predicates.recall_mentions_gamma_fact),
		deleteClearedBank: booleanAt(predicates.delete_cleared_bank),
		error: error ? stringAt(error.message) : null,
	};
}

async function loadReview(path: string): Promise<ReviewSummary> {
	const review = await readJson(path);
	return {
		name: stringAt(review.name) ?? timestampFromPath(path),
		artifactPath: relative(REPO_ROOT, path),
		model: stringAt(review.model),
		verdict: stringAt(review.verdict),
		confidence: stringAt(review.confidence),
		summary: stringAt(review.summary),
		notes: arrayAt(review.notes).map((note) => String(note)),
	};
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function scriptJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("</", "<\\/");
}

function buildReportData(runs: RunSummary[], suites: SuiteSummary[], hindsight: HindsightSummary[], reviews: ReviewSummary[]): ReportData {
	const passedRuns = runs.filter((run) => run.reward === 1 && run.status === "completed").length;
	const realModelRuns = runs.filter((run) => run.agentMode === "minimax-real").length;
	return {
		generatedAt: new Date().toISOString(),
		runs: runs.sort((left, right) => right.timestamp.localeCompare(left.timestamp)),
		suites: suites.sort((left, right) => right.timestamp.localeCompare(left.timestamp)),
		hindsight: hindsight.sort((left, right) => right.timestamp.localeCompare(left.timestamp)),
		reviews: reviews.sort((left, right) => left.name.localeCompare(right.name)),
		metrics: {
			totalRuns: runs.length,
			passedRuns,
			failedRuns: runs.length - passedRuns,
			realModelRuns,
			fauxRuns: runs.filter((run) => run.agentMode === "faux-text" || run.modelId === "none/verifier-only").length,
			hindsightPasses: hindsight.filter((smoke) => smoke.status === "passed").length,
			tasks: new Set(runs.map((run) => run.taskId)).size,
			conditions: new Set(runs.map((run) => run.conditionId)).size,
		},
	};
}

function html(data: ReportData): string {
	const title = "MemSWE Run Report";
	const metricCards = Object.entries({
		Runs: data.metrics.totalRuns,
		Passed: data.metrics.passedRuns,
		Failed: data.metrics.failedRuns,
		"Real model": data.metrics.realModelRuns,
		"Faux/verifier": data.metrics.fauxRuns,
		"Hindsight pass": data.metrics.hindsightPasses,
		Tasks: data.metrics.tasks,
		Conditions: data.metrics.conditions,
	})
		.map(([key, value]) => `<div class="card"><div class="k">${escapeHtml(key)}</div><div class="v">${value}</div></div>`)
		.join("");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
:root{color-scheme:dark;--bg:#080b12;--panel:#101827;--panel2:#0d1320;--muted:#8ea0b8;--text:#e8eef8;--ok:#2ed47a;--bad:#ff6b6b;--warn:#f8c14a;--accent:#7aa2ff;--line:#25324a;--chip:#18233a}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#172442 0,#080b12 38rem);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{padding:32px 40px 20px}h1{font-size:34px;margin:0 0 8px}h2{font-size:20px;margin:0 0 14px}h3{font-size:15px;margin:0 0 8px}.sub{color:var(--muted);max-width:1100px}.wrap{padding:0 40px 48px}.grid{display:grid;gap:16px}.cards{grid-template-columns:repeat(8,minmax(120px,1fr));margin-bottom:18px}.card,.panel{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:16px;box-shadow:0 10px 35px #0008}.card{padding:16px}.card .v{font-size:28px;font-weight:800}.card .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.two{grid-template-columns:1.15fr .85fr}.three{grid-template-columns:repeat(3,1fr)}.panel{padding:18px;margin:16px 0}.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}.toolbar input,.toolbar select{background:#0a1020;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px 12px}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid var(--line);padding:10px;text-align:left;vertical-align:top}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--chip);padding:3px 8px;border-radius:999px;font-size:12px}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.muted{color:var(--muted)}code{background:#050914;border:1px solid var(--line);border-radius:6px;padding:2px 5px;color:#d7e4ff}.bar{height:10px;background:#172033;border-radius:999px;overflow:hidden}.bar span{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--ok))}.timeline{display:flex;flex-direction:column;gap:10px}.event{display:grid;grid-template-columns:185px 1fr;gap:14px;border-left:2px solid var(--line);padding-left:12px}.note{background:#0a1020;border:1px solid var(--line);padding:12px;border-radius:12px;margin:8px 0}.small{font-size:12px}.scroll{overflow:auto;max-height:620px}.path{font-size:12px;color:#b8c7df;word-break:break-all}.preview{max-width:360px;color:#cbd7ea}.footer{color:var(--muted);font-size:12px;margin-top:24px}@media(max-width:1150px){.cards{grid-template-columns:repeat(4,1fr)}.two,.three{grid-template-columns:1fr}}@media(max-width:700px){header,.wrap{padding-left:18px;padding-right:18px}.cards{grid-template-columns:repeat(2,1fr)}.event{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
<h1>${title}</h1>
<div class="sub">Generated ${escapeHtml(data.generatedAt)} from <code>pi-memswe/.memswe-runs</code>. Deterministic verifier outputs are the source of truth. MiniMax/Hermes reviews are diagnostic only.</div>
</header>
<div class="wrap">
<section class="grid cards">
${metricCards}
</section>
<section class="panel">
<h2>Run explorer</h2>
<div class="toolbar"><input id="q" placeholder="Filter task, mode, model, path" /><select id="condition"><option value="">All conditions</option></select><select id="mode"><option value="">All modes</option></select><select id="outcome"><option value="">All outcomes</option><option value="passed">Passed</option><option value="failed">Failed</option></select></div>
<div class="scroll"><table><thead><tr><th>Time</th><th>Task / condition</th><th>Outcome</th><th>Agent/model</th><th>Verifiers</th><th>Artifacts</th><th>Response</th></tr></thead><tbody id="runs"></tbody></table></div>
</section>
<section class="grid two">
<div class="panel"><h2>Suite summaries</h2><div id="suites" class="timeline"></div></div>
<div class="panel"><h2>Hindsight lifecycle smokes</h2><div id="hindsight" class="timeline"></div></div>
</section>
<section class="panel"><h2>MiniMax / Hermes diagnostic reviews</h2><div id="reviews"></div></section>
<section class="panel"><h2>Interpretation guardrails</h2><div class="grid three"><div class="note"><h3>Scoring truth</h3><p>Visible/protected verifier outputs and run records determine pass/fail. Judge notes do not change task success.</p></div><div class="note"><h3>Real-model smoke</h3><p><code>minimax-real</code> proves provider/runtime inference and artifact capture. Tools are disabled, so this is not yet a full editing benchmark.</p></div><div class="note"><h3>Memory readiness</h3><p>Hindsight smoke proves local reset/retain/recall/delete lifecycle. Full <code>hindsight</code> condition execution in <code>memswe:smoke</code> is still future work.</p></div></div></section>
<div class="footer">Report generator: <code>packages/coding-agent/scripts/memswe-report-generator.ts</code></div>
</div>
<script id="report-data" type="application/json">${scriptJson(data)}</script>
<script>
const data=JSON.parse(document.getElementById('report-data').textContent);
const byId=(id)=>document.getElementById(id);
const esc=(s)=>String(s??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pass=(run)=>run.reward===1&&run.status==='completed';
const pct=(a,b)=>b?Math.round((a/b)*100):0;
function optionValues(field){return [...new Set(data.runs.map((r)=>r[field]).filter(Boolean))].sort();}
for(const c of optionValues('conditionId')) byId('condition').insertAdjacentHTML('beforeend','<option>'+esc(c)+'</option>');
for(const m of optionValues('agentMode')) byId('mode').insertAdjacentHTML('beforeend','<option>'+esc(m)+'</option>');
function renderRuns(){const q=byId('q').value.toLowerCase();const cond=byId('condition').value;const mode=byId('mode').value;const out=byId('outcome').value;const rows=data.runs.filter((r)=>{const text=JSON.stringify(r).toLowerCase();if(q&&!text.includes(q))return false;if(cond&&r.conditionId!==cond)return false;if(mode&&r.agentMode!==mode)return false;if(out==='passed'&&!pass(r))return false;if(out==='failed'&&pass(r))return false;return true;}).map((r)=>{const ok=pass(r);const verifier='V '+r.visiblePassed+'/'+r.visibleTotal+'<br/>P '+r.protectedPassed+'/'+r.protectedTotal+'<br/><span class="muted">hidden skipped '+r.hiddenSkipped+'</span>';const agent=r.agentMode?esc(r.agentMode)+'<br/><code>'+esc(r.providerModel||r.modelId)+'</code><br/><span class="muted">events '+esc(r.eventCount??'n/a')+' / messages '+esc(r.messageCount??'n/a')+'</span>':'<span class="muted">'+esc(r.modelId)+'</span>';return '<tr><td><code>'+esc(r.timestamp)+'</code></td><td><strong>'+esc(r.taskId)+'</strong><br/><span class="pill">'+esc(r.conditionId)+'</span></td><td><span class="pill '+(ok?'ok':'bad')+'">'+(ok?'passed':'failed')+'</span><br/><span class="muted">reward '+esc(r.reward)+'</span></td><td>'+agent+'<br/><span class="muted small">'+esc(r.baseUrl||'')+'</span></td><td>'+verifier+'<div class="bar"><span style="width:'+pct(r.visiblePassed+r.protectedPassed,r.visibleTotal+r.protectedTotal)+'%"></span></div></td><td><div class="path">'+esc(r.artifactPath)+'</div>'+(r.agentResultPath?'<div class="path">'+esc(r.agentResultPath)+'</div>':'')+'</td><td class="preview">'+esc(r.finalResponsePreview||'')+'</td></tr>';}).join('');byId('runs').innerHTML=rows||'<tr><td colspan="7" class="muted">No matching runs.</td></tr>';}
for(const id of ['q','condition','mode','outcome']) byId(id).addEventListener('input',renderRuns);
renderRuns();
byId('suites').innerHTML=data.suites.map((s)=>'<div class="event"><div><code>'+esc(s.timestamp)+'</code><br/><span class="pill '+(s.failed?'warn':'ok')+'">'+s.passed+' pass / '+s.failed+' fail</span></div><div><div class="path">'+esc(s.artifactPath)+'</div>'+s.tasks.map((t)=>'<span class="pill '+(t.status==='passed'?'ok':'bad')+'">'+esc(t.taskId)+': '+esc(t.status)+(t.failedPhase?' / '+esc(t.failedPhase):'')+'</span>').join(' ')+'</div></div>').join('')||'<p class="muted">No suite summaries.</p>';
byId('hindsight').innerHTML=data.hindsight.map((h)=>'<div class="event"><div><code>'+esc(h.timestamp)+'</code><br/><span class="pill '+(h.status==='passed'?'ok':'bad')+'">'+esc(h.status)+'</span></div><div><div class="path">'+esc(h.artifactPath)+'</div><p>trace events: <strong>'+h.traceEvents+'</strong>; retain: <strong>'+h.retainVisible+'</strong>; recall: <strong>'+h.recallMentionsGammaFact+'</strong>; delete: <strong>'+h.deleteClearedBank+'</strong></p><p class="muted">'+esc(h.error||'')+'</p></div></div>').join('')||'<p class="muted">No Hindsight smokes.</p>';
byId('reviews').innerHTML=data.reviews.map((r)=>'<div class="note"><h3>'+esc(r.name)+' <span class="pill">'+esc(r.model||'unknown model')+'</span> <span class="pill '+(r.verdict==='pass'?'ok':r.verdict==='fail'?'bad':'warn')+'">'+esc(r.verdict||'diagnostic')+'</span></h3><p>'+esc(r.summary||'')+'</p><ul>'+r.notes.map((n)=>'<li>'+esc(n)+'</li>').join('')+'</ul><div class="path">'+esc(r.artifactPath)+'</div></div>').join('')||'<p class="muted">No diagnostic review files found yet.</p>';
</script>
</body>
</html>`;
}

async function main(): Promise<void> {
	const files = await walkFiles(RUNS_ROOT);
	const runFiles = files.filter((file) => file.endsWith("/run-record.json"));
	const suiteFiles = files.filter((file) => file.endsWith("/suite-summary.json"));
	const hindsightFiles = files.filter((file) => file.endsWith("/hindsight-smoke-result.json"));
	const reviewFiles = files.filter((file) => file.includes("/.memswe-runs/reviews/") && file.endsWith(".json"));

	const data = buildReportData(
		await Promise.all(runFiles.map(loadRun)),
		await Promise.all(suiteFiles.map(loadSuite)),
		await Promise.all(hindsightFiles.map(loadHindsight)),
		await Promise.all(reviewFiles.map(loadReview)),
	);
	const timestamp = data.generatedAt.replaceAll(":", "-").replaceAll(".", "-");
	const reportDir = join(REPORTS_ROOT, timestamp);
	await mkdir(reportDir, { recursive: true });
	await writeFile(join(reportDir, "run-summary.json"), `${JSON.stringify(data, null, "\t")}\n`);
	await writeFile(join(reportDir, "index.html"), html(data));
	await mkdir(join(REPORTS_ROOT, "latest"), { recursive: true });
	await writeFile(join(REPORTS_ROOT, "latest", "run-summary.json"), `${JSON.stringify(data, null, "\t")}\n`);
	await writeFile(join(REPORTS_ROOT, "latest", "index.html"), html(data));
	console.log(`Wrote ${relative(REPO_ROOT, join(reportDir, "index.html"))}`);
	console.log(`Wrote ${relative(REPO_ROOT, join(REPORTS_ROOT, "latest", "index.html"))}`);
}

await main();
