-- 每条会话都记一个明确的权限档,读取端从此缺档即报错(❌ 再按默认值猜)。存量里没记档的会话,一直以来都由
-- resolveSessionPermissionMode 解成 'edit'(Codex 终端腿的旧物化器、OpenCode 的旧审批规则也是同一档,0035 折布尔时
-- false 也是 'edit'),这里把这个实际生效的值写进记录本身。只动 config 为空或是合法 JSON 的行;坏 JSON 的行这一列本来就
-- 读不出(versionedJsonColumn 解成 null),起会话时由读取端响亮报错。
UPDATE `sessions`
SET `config` = json_set(COALESCE(`config`, json_object()), '$.permissionMode', 'edit')
WHERE (`config` IS NULL OR json_valid(`config`)) AND json_extract(COALESCE(`config`, json_object()), '$.permissionMode') IS NULL;
