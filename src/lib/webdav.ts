import { invoke } from "@tauri-apps/api/core";

export interface WebdavConfig {
  enabled: boolean;
  url: string;
  user: string;
  remotePath: string;
  /** 解密后的明文密码（用于回填输入框） */
  pass?: string;
  lastSync: number;
}

export interface WebdavStatus {
  enabled: boolean;
  lastSync: number;
}

/** 保存 WebDAV 配置。密码为空字符串表示不修改已保存的密码。 */
export async function webdavSetConfig(cfg: {
  enabled?: boolean;
  url?: string;
  user?: string;
  pass?: string;
  remotePath?: string;
}): Promise<void> {
  await invoke("webdav_set_config", { config: cfg });
}

/** 读取当前 WebDAV 配置（密码仅返回是否已设置）。 */
export async function webdavGetConfig(): Promise<WebdavConfig> {
  return await invoke<WebdavConfig>("webdav_get_config");
}

/** 测试连接。使用当前输入框的临时配置，成功返回提示文本，失败抛错。 */
export async function webdavTest(cfg: {
  url: string;
  user: string;
  pass: string;
  remotePath?: string;
}): Promise<string> {
  return await invoke<string>("webdav_test", { payload: cfg });
}

/** 立即单向上传（本地 → 云端）。可传入当前输入框的临时配置，成功返回提示文本，失败抛错。 */
export async function webdavSyncNow(cfg: {
  url: string;
  user: string;
  pass: string;
  remotePath?: string;
}): Promise<string> {
  return await invoke<string>("webdav_sync_now", { payload: cfg });
}

/** 从云端恢复（下载覆盖本地，危险操作）。可传入当前输入框的临时配置。 */
export async function webdavRestore(cfg: {
  url: string;
  user: string;
  pass: string;
  remotePath?: string;
}): Promise<string> {
  return await invoke<string>("webdav_restore", { payload: cfg });
}

/**
 * 内容变化后的自动同步：不传临时配置，直接用已保存的配置。
 *
 * Rust 侧会先比对内容指纹，内容没变就直接返回、不发任何网络请求，
 * 所以调用方不必自己判断"值不值得同步"，多调用几次也没有网络开销。
 */
export async function webdavAutoSync(): Promise<void> {
  await invoke("webdav_sync_now", { payload: null });
}

/** 读取同步状态。 */
export async function webdavStatus(): Promise<WebdavStatus> {
  return await invoke<WebdavStatus>("webdav_status");
}
