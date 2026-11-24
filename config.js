// Configuración pública de la app (no contiene secretos).
// Supabase → Project Settings → API Keys:
//   SUPABASE_URL  = "Project URL"           ej. https://abcdxyz.supabase.co
//   SUPABASE_KEY  = "Publishable key"       ej. sb_publishable_xxx  (o la anon key en proyectos antiguos)
// Nunca pongas aquí la "secret" / service_role key.
window.APP_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_KEY: '',
  // Métodos de inicio de sesión que se muestran: 'email' (código por correo) y/o 'google'
  LOGIN_METHODS: ['email', 'google']
};
