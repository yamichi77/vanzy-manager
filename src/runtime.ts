import { invoke, isTauri } from "@tauri-apps/api/core";
export type RuntimeCapabilities = {
  hardware_enabled: false;
  demo_only: true;
  platform: string;
  protocol_status: "unverified";
  supported_operations: string[];
};
export async function getRuntimeCapabilities(): Promise<RuntimeCapabilities> {
  if (!isTauri())
    return {
      hardware_enabled: false,
      demo_only: true,
      platform: "browser",
      protocol_status: "unverified",
      supported_operations: [],
    };
  const result: unknown = await invoke("get_runtime_capabilities");
  const value = result as Partial<RuntimeCapabilities> | null;
  if (
    !value ||
    typeof value !== "object" ||
    value.hardware_enabled !== false ||
    value.demo_only !== true ||
    value.protocol_status !== "unverified" ||
    !Array.isArray(value.supported_operations) ||
    value.supported_operations.length !== 0 ||
    typeof value.platform !== "string"
  )
    throw new Error("実機機能を安全に無効化できないため停止しました。");
  return value as RuntimeCapabilities;
}
