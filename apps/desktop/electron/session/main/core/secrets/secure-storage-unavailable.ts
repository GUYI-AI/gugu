/**
 * 这台电脑没有系统钥匙串可用(Linux 上只有 basic_text,或 safeStorage 整个不可用):咕咕 ❌ 把凭据明文落盘。
 * 单独一个文件:连接服务按类型认它、换成界面语言的一句话,❌ 为认一个错误把 electron / 数据库牵进来。
 */
export class SecureStorageUnavailableError extends Error {
  override readonly name = 'SecureStorageUnavailableError';
}
