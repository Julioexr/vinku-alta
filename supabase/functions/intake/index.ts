// Edge Function "intake": formulario de alta de clientes (público, sin JWT).
// GET  ?t=<token>  → datos para prellenar el formulario
// POST {t, services, answers, state} → guarda las respuestas y las aplica al cliente
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const ALLOWED = (Deno.env.get("INTAKE_ORIGINS") ?? "https://alta.vinku.es,https://julioexr.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_BYTES = 100_000;

const cors = (req: Request) => {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED.includes(o) ? o : ALLOWED[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
};
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "content-type": "application/json" } });
const validToken = (t: unknown): t is string => typeof t === "string" && /^[a-f0-9]{64}$/.test(t);
const isObj = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

// Aviso a Julio por Telegram (secretos TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID). Sin secretos, no hace nada.
async function notify(text: string) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN"), chat = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error("telegram", e);
  }
}
const LABELS: Record<string, string> = {
  gmail: "su Gmail", reenvio: "correo con dominio reenviado a Gmail", zoho: "buzón propio con dominio",
  llamada: "usuario y contraseña en la llamada", invitar: "nos invita como administradores",
  nueva: "línea nueva", actual: "su número actual (coexistencia)", ninguno: "sin WhatsApp",
};
const label = (v: unknown) => (typeof v === "string" ? LABELS[v] ?? v : "—");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  try {
    if (req.method === "GET") {
      const t = new URL(req.url).searchParams.get("t");
      if (!validToken(t)) return json(req, { error: "not_found" }, 404);
      const { data: row, error } = await sb.from("client_intakes")
        .select("id, status, expires_at, prefill, services, form_state, clients(name)")
        .eq("token", t).maybeSingle();
      if (error) throw error;
      if (!row) return json(req, { error: "not_found" }, 404);
      if (new Date(row.expires_at) < new Date()) return json(req, { error: "expired" }, 410);
      // deno-lint-ignore no-explicit-any
      const name = (row as any).clients?.name ?? "";
      if (row.status === "sent") {
        await sb.from("client_intakes").update({ status: "opened", opened_at: new Date().toISOString() }).eq("id", row.id);
        await notify(`👀 ${name} ha abierto su formulario de alta.`);
      }
      const submitted = row.status === "submitted" || row.status === "reviewed";
      return json(req, {
        client_name: name,
        prefill: submitted && row.form_state ? row.form_state : row.prefill,
        services: row.services,
        submitted,
      });
    }

    if (req.method === "POST") {
      const raw = await req.text();
      if (raw.length > MAX_BYTES) return json(req, { error: "too_large" }, 413);
      const body = JSON.parse(raw);
      if (!validToken(body?.t) || !isObj(body.answers)) return json(req, { error: "bad_request" }, 400);

      const { data: row, error } = await sb.from("client_intakes")
        .select("id, expires_at, status, clients(name)").eq("token", body.t).maybeSingle();
      if (error) throw error;
      if (!row) return json(req, { error: "not_found" }, 404);
      if (new Date(row.expires_at) < new Date()) return json(req, { error: "expired" }, 410);

      const { data: cat } = await sb.from("service_catalog").select("code").eq("active", true);
      const codes = new Set((cat ?? []).map((c) => c.code));
      const services = Array.isArray(body.services)
        ? [...new Set(body.services.filter((s: unknown) => typeof s === "string" && codes.has(s)))]
        : [];

      const { error: e1 } = await sb.from("client_intakes").update({
        answers: body.answers,
        form_state: isObj(body.state) ? body.state : null,
        services,
        status: "submitted",
        submitted_at: new Date().toISOString(),
      }).eq("id", row.id);
      if (e1) throw e1;

      const { error: e2 } = await sb.rpc("apply_intake", { _id: row.id });
      if (e2) throw e2;

      const a = body.answers;
      const again = row.status === "submitted" || row.status === "reviewed";
      // deno-lint-ignore no-explicit-any
      const who = (row as any).clients?.name ?? "Un cliente";
      await notify([
        `✅ ${who} ${again ? "ha corregido y reenviado" : "ha enviado"} su formulario de alta.`,
        `Servicios: ${services.length}`,
        `Correo: ${label(a?.cuentas?.correo)}`,
        `Accesos: ${label(a?.cuentas?.acceso)}`,
        a?.whatsapp?.opcion ? `WhatsApp: ${label(a.whatsapp.opcion)}` : "",
        "Revisa sus respuestas en el backoffice (pestaña Alta).",
      ].filter(Boolean).join("\n"));

      const hook = Deno.env.get("INTAKE_NOTIFY_URL"); // webhook opcional de n8n
      if (hook) {
        fetch(hook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: "intake.submitted", intake_id: row.id }),
        }).catch(() => {});
      }
      return json(req, { ok: true });
    }

    return json(req, { error: "method_not_allowed" }, 405);
  } catch (e) {
    console.error(e);
    return json(req, { error: "server_error" }, 500);
  }
});
