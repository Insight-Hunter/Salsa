import { Hono } from "hono";
import { cors } from "hono/cors";
import { bearerAuth } from "hono/bearer-auth";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Env {
  DB: D1Database;
  PAYROLL_KV: KVNamespace;
  PAYROLL_QUEUE: Queue;
  SALSA_API_KEY: string;
  SALSA_PARTNER_ID: string;
  JWT_SECRET: string;
  SALSA_API_BASE: string;
  ENV: string;
}

interface SalsaEmployerPayload {
  legalName: string;
  ein?: string;
  address: {
    line1: string;
    city: string;
    state: string;
    zip: string;
    country: "US" | "CA";
  };
  contact: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  };
}

interface SalsaWorkerPayload {
  employerId: string;
  firstName: string;
  lastName: string;
  email: string;
  workerType: "W2" | "1099";
  startDate: string; // YYYY-MM-DD
  compensation: {
    type: "HOURLY" | "SALARY";
    amount: number; // cents
    payFrequency?: "WEEKLY" | "BIWEEKLY" | "SEMIMONTHLY" | "MONTHLY";
  };
}

// ─── Salsa Client ─────────────────────────────────────────────────────────────

class SalsaClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(env: Env) {
    this.baseUrl = env.ENV === "production" ? env.SALSA_API_BASE : env.SALSA_API_BASE.replace("api.", "api.sandbox.");
    this.apiKey = env.SALSA_API_KEY;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Salsa API error ${res.status}: ${err}`);
    }
    return res.json<T>();
  }

  async createEmployer(payload: SalsaEmployerPayload) {
    return this.request<{ id: string; status: string }>("POST", "/employers", payload);
  }

  async getEmployer(salsaEmployerId: string) {
    return this.request<{ id: string; status: string; onboardingUrl?: string }>(
      "GET", `/employers/${salsaEmployerId}`
    );
  }

  async createWorker(payload: SalsaWorkerPayload) {
    return this.request<{ id: string }>("POST", "/workers", payload);
  }

  async createPayrollRun(employerId: string, payPeriodStart: string, payPeriodEnd: string) {
    return this.request<{ id: string; status: string }>("POST", "/payroll-runs", {
      employerId,
      payPeriodStart,
      payPeriodEnd,
    });
  }

  async addPayrollItems(runId: string, items: Array<{ workerId: string; hours?: number; amount?: number }>) {
    return this.request("POST", `/payroll-runs/${runId}/items`, { items });
  }

  async approvePayrollRun(runId: string) {
    return this.request("POST", `/payroll-runs/${runId}/approve`, {});
  }

  // Generate a short-lived UI session token for Salsa Express embedding
  async getSessionToken(employerId: string) {
    return this.request<{ token: string; expiresAt: string }>(
      "POST", "/session-tokens", { employerId }
    );
  }
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({
  origin: ["https://app.insighthunter.com", "http://localhost:4321"],
  allowHeaders: ["Authorization", "Content-Type"],
  allowMethods: ["GET", "POST", "PATCH", "DELETE"],
}));

// Health check (public)
app.get("/health", (c) => c.json({ status: "ok", service: "insighthunter-payroll" }));

// ─── Employer Routes ──────────────────────────────────────────────────────────

// Create or retrieve Salsa employer for a given InsightHunter companyId
app.post("/employers", async (c) => {
  const { companyId, ...payload }: { companyId: string } & SalsaEmployerPayload = await c.req.json();

  if (!companyId) return c.json({ error: "companyId required" }, 400);

  // Check if already created
  const existing = await c.env.DB.prepare(
    "SELECT salsa_employer_id FROM salsa_employers WHERE id = ?"
  ).bind(companyId).first<{ salsa_employer_id: string }>();

  if (existing) {
    return c.json({ employerId: existing.salsa_employer_id, existing: true });
  }

  const salsa = new SalsaClient(c.env);
  const employer = await salsa.createEmployer(payload);

  await c.env.DB.prepare(
    "INSERT INTO salsa_employers (id, salsa_employer_id) VALUES (?, ?)"
  ).bind(companyId, employer.id).run();

  return c.json({ employerId: employer.id, existing: false }, 201);
});

// Get employer status & onboarding URL
app.get("/employers/:companyId", async (c) => {
  const { companyId } = c.req.param();

  const row = await c.env.DB.prepare(
    "SELECT salsa_employer_id FROM salsa_employers WHERE id = ?"
  ).bind(companyId).first<{ salsa_employer_id: string }>();

  if (!row) return c.json({ error: "Employer not found" }, 404);

  const salsa = new SalsaClient(c.env);
  const employer = await salsa.getEmployer(row.salsa_employer_id);

  return c.json(employer);
});

// ─── Session Token (for Salsa Express UI embedding) ───────────────────────────

app.post("/session-token", async (c) => {
  const { companyId } = await c.req.json<{ companyId: string }>();

  const row = await c.env.DB.prepare(
    "SELECT salsa_employer_id FROM salsa_employers WHERE id = ?"
  ).bind(companyId).first<{ salsa_employer_id: string }>();

  if (!row) return c.json({ error: "Employer not found — run onboarding first" }, 404);

  // Cache token in KV for ~50 min (tokens expire at 60 min)
  const cacheKey = `session_token:${companyId}`;
  const cached = await c.env.PAYROLL_KV.get(cacheKey);
  if (cached) return c.json({ token: cached });

  const salsa = new SalsaClient(c.env);
  const { token } = await salsa.getSessionToken(row.salsa_employer_id);

  await c.env.PAYROLL_KV.put(cacheKey, token, { expirationTtl: 3000 }); // 50 min

  return c.json({ token });
});

// ─── Worker Routes ────────────────────────────────────────────────────────────

app.post("/workers", async (c) => {
  const { companyId, employeeId, ...payload }: {
    companyId: string;
    employeeId: string;
  } & Omit<SalsaWorkerPayload, "employerId"> = await c.req.json();

  const row = await c.env.DB.prepare(
    "SELECT salsa_employer_id FROM salsa_employers WHERE id = ?"
  ).bind(companyId).first<{ salsa_employer_id: string }>();

  if (!row) return c.json({ error: "Employer not found" }, 404);

  const salsa = new SalsaClient(c.env);
  const worker = await salsa.createWorker({ ...payload, employerId: row.salsa_employer_id });

  await c.env.DB.prepare(
    "INSERT INTO salsa_workers (id, employer_id, salsa_worker_id, worker_type) VALUES (?, ?, ?, ?)"
  ).bind(employeeId, companyId, worker.id, payload.workerType).run();

  return c.json({ workerId: worker.id }, 201);
});

// ─── Payroll Run Routes ───────────────────────────────────────────────────────

app.post("/payroll-runs", async (c) => {
  const { companyId, payPeriodStart, payPeriodEnd } = await c.req.json<{
    companyId: string;
    payPeriodStart: string;
    payPeriodEnd: string;
  }>();

  const row = await c.env.DB.prepare(
    "SELECT salsa_employer_id FROM salsa_employers WHERE id = ?"
  ).bind(companyId).first<{ salsa_employer_id: string }>();

  if (!row) return c.json({ error: "Employer not found" }, 404);

  const salsa = new SalsaClient(c.env);
  const run = await salsa.createPayrollRun(row.salsa_employer_id, payPeriodStart, payPeriodEnd);

  const runId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO salsa_payroll_runs (id, employer_id, salsa_run_id, status, pay_period_start, pay_period_end)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(runId, companyId, run.id, run.status, payPeriodStart, payPeriodEnd).run();

  return c.json({ runId, salsaRunId: run.id, status: run.status }, 201);
});

// Submit hours/amounts for a run
app.post("/payroll-runs/:runId/items", async (c) => {
  const { runId } = c.req.param();
  const { items } = await c.req.json<{
    items: Array<{ employeeId: string; hours?: number; amount?: number }>;
  }>();

  const runRow = await c.env.DB.prepare(
    "SELECT salsa_run_id FROM salsa_payroll_runs WHERE id = ?"
  ).bind(runId).first<{ salsa_run_id: string }>();

  if (!runRow) return c.json({ error: "Payroll run not found" }, 404);

  // Map employeeIds → salsaWorkerIds
  const workerIds = items.map((i) => i.employeeId);
  const placeholders = workerIds.map(() => "?").join(",");
  const workerRows = await c.env.DB.prepare(
    `SELECT id, salsa_worker_id FROM salsa_workers WHERE id IN (${placeholders})`
  ).bind(...workerIds).all<{ id: string; salsa_worker_id: string }>();

  const workerMap = Object.fromEntries(workerRows.results.map((r) => [r.id, r.salsa_worker_id]));
  const salsaItems = items
    .filter((i) => workerMap[i.employeeId])
    .map((i) => ({ workerId: workerMap[i.employeeId], hours: i.hours, amount: i.amount }));

  const salsa = new SalsaClient(c.env);
  await salsa.addPayrollItems(runRow.salsa_run_id, salsaItems);

  return c.json({ submitted: salsaItems.length });
});

// Approve and run payroll
app.post("/payroll-runs/:runId/approve", async (c) => {
  const { runId } = c.req.param();

  const runRow = await c.env.DB.prepare(
    "SELECT salsa_run_id FROM salsa_payroll_runs WHERE id = ?"
  ).bind(runId).first<{ salsa_run_id: string }>();

  if (!runRow) return c.json({ error: "Payroll run not found" }, 404);

  const salsa = new SalsaClient(c.env);
  const result = await salsa.approvePayrollRun(runRow.salsa_run_id);

  await c.env.DB.prepare("UPDATE salsa_payroll_runs SET status = ? WHERE id = ?")
    .bind(result.status, runId).run();

  await c.env.PAYROLL_QUEUE.send({ event: "payroll_approved", runId, salsaRunId: runRow.salsa_run_id });

  return c.json(result);
});

// ─── Salsa Webhook Handler ────────────────────────────────────────────────────

app.post("/webhooks/salsa", async (c) => {
  // TODO: Verify Salsa webhook signature (HMAC-SHA256 over raw body)
  const payload = await c.req.json<{ event: string;  Record<string, unknown> }>();

  console.log("Salsa webhook:", payload.event, JSON.stringify(payload.data));

  // Queue for async processing
  await c.env.PAYROLL_QUEUE.send({ source: "salsa_webhook", ...payload });

  return c.json({ received: true });
});

// ─── Queue Consumer ───────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const body = msg.body as Record<string, unknown>;
      console.log("Processing queue message:", body.event ?? body.source);

      if (body.event === "payroll.run.completed") {
        // TODO: update run status, trigger InsightHunter accounting sync
      }

      msg.ack();
    }
  },
};
