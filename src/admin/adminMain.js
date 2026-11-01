import { AiCampaignPanel } from './AiCampaignPanel.js';

// Entry for admin.html. admin.html owns the password and exposes
// window.AdminApi.call(payload); this file only mounts the AI campaign UI.
const root = document.getElementById('aiCampaignRoot');
if (root && window.AdminApi) {
  const panel = new AiCampaignPanel(root, window.AdminApi);
  window.addEventListener('admin:locked', () => panel.stop());
}