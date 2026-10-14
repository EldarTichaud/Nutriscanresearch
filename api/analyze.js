// api/analyze.js — proxy vers l'API Anthropic (NSR v0.9.6)
// Accès réservé : compte connecté ET appartenant à l'étude
// (investigateur, ou patient rattaché à un projet). Le modèle et la taille
// des réponses sont imposés ici, pas par le navigateur.

export const config = { maxDuration: 60 };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nhxrrfdwebfaoxyvnwes.supabase.co';
// Clé "anon" : publique par conception (déjà présente dans l'application).
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5oeHJyZmR3ZWJmYW94eXZud2VzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNTg1ODQsImV4cCI6MjA5MzgzNDU4NH0.Ekmpm6LvL6sIr-n1qnyad--XMgzyJBk-vWh_mLq_xTY';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS_CAP = 4000;
const MAX_MESSAGES = 10;
const RATE_LIMIT = 30;          // appels par minute et par compte (meilleur effort)
const RATE_WINDOW_MS = 60 * 1000;
const hits = new Map();

function err(res, status, message) {
  return res.status(status).json({ error: { message } });
}

function rateLimited(uid) {
  const now = Date.now();
  const recent = (hits.get(uid) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) { hits.set(uid, recent); return true; }
  recent.push(now);
  hits.set(uid, recent);
  return false;
}

async function sbGet(path, token) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token }
  });
  if (!r.ok) return null;
  return r.json();
}

async function authorize(token) {
  // 1) le jeton est-il valide ?
  const u = await sbGet('/auth/v1/user', token);
  if (!u || !u.id) return null;
  const uid = u.id;
  // 2) le compte appartient-il à l'étude ? (lecture avec le jeton de l'utilisateur : la RLS s'applique)
  const prof = await sbGet('/rest/v1/profiles?select=role&id=eq.' + encodeURIComponent(uid), token);
  if (Array.isArray(prof) && prof[0] && prof[0].role === 'investigateur') return uid;
  const link = await sbGet('/rest/v1/project_patients?select=project_id&limit=1&patient_id=eq.' + encodeURIComponent(uid), token);
  if (Array.isArray(link) && link.length > 0) return uid;
  return null;
}

function validMessages(m) {
  if (!Array.isArray(m) || m.length < 1 || m.length > MAX_MESSAGES) return false;
  return m.every(x => x && (x.role === 'user' || x.role === 'assistant') &&
    (typeof x.content === 'string' ||
      (Array.isArray(x.content) && x.content.length > 0 &&
        x.content.every(b => b && (b.type === 'text' || b.type === 'image')))));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return err(res, 405, 'Method not allowed');

  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) return err(res, 500, 'Clé API non configurée sur le serveur');

  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return err(res, 401, 'Connexion requise');

  let uid;
  try { uid = await authorize(token); } catch (e) { return err(res, 502, 'Vérification du compte impossible'); }
  if (!uid) return err(res, 403, 'Accès refusé');
  if (rateLimited(uid)) return err(res, 429, 'Trop de requêtes, réessayez dans une minute');

  const body = req.body || {};
  if (!validMessages(body.messages)) return err(res, 400, 'Requête invalide');

  const upstream = {
    model: MODEL,
    max_tokens: Math.min(Math.max(parseInt(body.max_tokens, 10) || 1000, 1), MAX_TOKENS_CAP),
    messages: body.messages
  };
  if (typeof body.system === 'string' && body.system.length <= 20000) upstream.system = body.system;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(upstream)
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (e) {
    return err(res, 500, e.message);
  }
}
