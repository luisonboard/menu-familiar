// Configuración pública de la app (no contiene secretos).
// Supabase → Project Settings → API Keys:
//   SUPABASE_URL  = "Project URL"           ej. https://abcdxyz.supabase.co
//   SUPABASE_KEY  = "Publishable key"       ej. sb_publishable_xxx  (o la anon key en proyectos antiguos)
// Nunca pongas aquí la "secret" / service_role key.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://delduxutruogliddvmzp.supabase.co',
  SUPABASE_KEY: 'sb_publishable_s8at-SaPdCoy14iNaQoAKA_p61cMIZy',
  // Métodos de inicio de sesión: 'password' (usuarios creados en Supabase → Authentication → Users),
  // 'email' (enlace por correo; sin SMTP propio solo llega a miembros del equipo) y 'google'
  LOGIN_METHODS: ['password', 'email']
};
