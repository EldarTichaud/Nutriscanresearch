// api/push-notify.js
// NSR — Vercel Cron Job : envoi des notifications push aux patients
// Schedule : toutes les 30 minutes (*/30 * * * *)
// Vérifie si l'heure courante correspond à un créneau de rappel (± 15 min)

const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

webpush.setVapidDetails(
  'mailto:' + process.env.MAINTENANCE_RECIPIENT_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async function handler(req, res) {
  // Auth Vercel Cron
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  // Heure courante en HH:MM (UTC — adapter si nécessaire selon le fuseau de l'étude)
  const currentTime = now.toTimeString().slice(0, 5); // "HH:MM"

  // Charger tous les patients avec une push subscription active
  const { data: links, error } = await supabase
    .from('project_patients')
    .select('patient_id, project_id, push_subscription, reminder_times, notifications_refused')
    .not('push_subscription', 'is', null)
    .eq('notifications_refused', false);

  if (error) {
    console.error('[NSR Push] Supabase error:', error);
    return res.status(500).json({ error: error.message });
  }

  const results = { sent: 0, skipped: 0, errors: 0 };

  for (const link of (links || [])) {
    const times = link.reminder_times || ['08:00', '12:30', '16:00', '19:30'];

    // Vérifier si l'heure courante correspond à un créneau (± 15 min)
    const isMatchingSlot = times.some(function(t) {
      const [h, m] = t.split(':').map(Number);
      const slotMins = h * 60 + m;
      const [ch, cm] = currentTime.split(':').map(Number);
      const nowMins = ch * 60 + cm;
      return Math.abs(slotMins - nowMins) <= 15;
    });

    if (!isMatchingSlot) { results.skipped++; continue; }

    // Construire le message selon le créneau
    const mealLabels = {
      '08:00': 'votre petit-déjeuner 🌅',
      '12:30': 'votre déjeuner ☀️',
      '16:00': 'votre collation 🍎',
      '19:30': 'votre dîner 🌙'
    };
    const closestSlot = times.reduce(function(prev, curr) {
      const [ph, pm] = prev.split(':').map(Number);
      const [ch2, cm2] = curr.split(':').map(Number);
      const [nowh, nowm] = currentTime.split(':').map(Number);
      return Math.abs(ph * 60 + pm - (nowh * 60 + nowm)) <
             Math.abs(ch2 * 60 + cm2 - (nowh * 60 + nowm)) ? prev : curr;
    });
    const mealLabel = mealLabels[closestSlot] || 'votre repas';

    const payload = JSON.stringify({
      title: 'NutriScanResearch',
      body: 'N\'oubliez pas de saisir ' + mealLabel + ' !',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      url: '/'
    });

    try {
      await webpush.sendNotification(link.push_subscription, payload);
      results.sent++;
    } catch (err) {
      console.error('[NSR Push] Send error for patient', link.patient_id, err.statusCode);
      // Si subscription expirée (410) → la nettoyer
      if (err.statusCode === 410) {
        await supabase.from('project_patients')
          .update({ push_subscription: null })
          .eq('patient_id', link.patient_id)
          .eq('project_id', link.project_id);
      }
      results.errors++;
    }
  }

  console.log('[NSR Push]', now.toISOString(), results);
  return res.status(200).json({ success: true, time: currentTime, ...results });
};
