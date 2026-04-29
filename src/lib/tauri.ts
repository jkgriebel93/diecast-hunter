import { invoke } from "@tauri-apps/api/core";

export interface AppStatus {
  db_path: string;
  schema_version: number;
  registry_count: number;
  collection_count: number;
  listing_count: number;
}

export interface CredentialState {
  diecastregistry_username: string | null;
  diecastregistry_has_password: boolean;
  ebay_connected: boolean;
}

export const api = {
  status: () => invoke<AppStatus>("app_status"),
  getCredentials: () => invoke<CredentialState>("get_credentials"),
  saveDiecastRegistryCredentials: (username: string, password: string) =>
    invoke<void>("save_diecastregistry_credentials", { username, password }),
  clearDiecastRegistryCredentials: () =>
    invoke<void>("clear_diecastregistry_credentials"),
  getSetting: (key: string) =>
    invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
};
