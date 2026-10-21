/// <reference types="vite/client" />

import { createClient } from "@supabase/supabase-js";

const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

function validProjectUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const localHttp = import.meta.env.DEV &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.protocol === "http:";
    if (
      (url.protocol !== "https:" && !localHttp) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const supabaseUrl = validProjectUrl(rawSupabaseUrl);
export const hostedAuthConfigured = Boolean(supabaseUrl && supabaseAnonKey);
export const supabase = hostedAuthConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    })
  : null;

export async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
}
