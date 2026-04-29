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

export interface SyncSummary {
  items_seen: number;
  drivers_upserted: number;
  registry_entries_upserted: number;
  collection_rows_upserted: number;
  pages_fetched: number;
}

export interface DriverGroup {
  driver_id: number;
  driver_name: string;
  item_count: number;
  retail_total_cents: number;
  wholesale_total_cents: number;
}

export interface CollectionRow {
  collection_id: number;
  asset_guid: string;
  driver_id: number | null;
  driver_name: string | null;
  year: number | null;
  oem: string | null;
  brand: string | null;
  scale: string | null;
  make: string | null;
  scheme_text: string | null;
  image_url: string | null;
  detail_url: string | null;
  retail_value_cents: number | null;
  wholesale_value_cents: number | null;
  registry_int_id: number | null;
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
  syncDcrCollection: () => invoke<SyncSummary>("sync_dcr_collection"),
  listDriversWithCounts: () =>
    invoke<DriverGroup[]>("list_drivers_with_counts"),
  listCollectionForDriver: (driverId: number) =>
    invoke<CollectionRow[]>("list_collection_for_driver", { driverId }),
};

export function formatCents(cents: number | null): string {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}
