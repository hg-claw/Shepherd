# Shepherd 移动端使用文档

Shepherd 的 iOS / Android App（Expo + React Native，位于仓库 `mobile/` 目录），把
管理后台的核心能力带到手机上：服务器监控、**远程终端**、文件浏览、脚本执行、插件
管理，以及一个生物识别 App 锁。

> 适用版本：App v1.0.0（随后端 v0.23.0–v0.28.0 的 R1–R6 一并交付）。
> 推送通知（R7）尚未实现，见文末「未包含的功能」。

---

## 1. 重要前提：需要 Development Build，不能用 Expo Go

App 依赖两个**原生模块**——`react-native-webview`（真终端用）和
`expo-local-authentication`（生物识别锁）。它们不在 Expo Go 沙盒里，所以**必须用
development build（开发构建）或正式打包安装**，Expo Go 打不开终端 / 锁。

需要的环境：
- Node.js 20+ 与 npm
- 要跑 iOS：macOS + Xcode；要跑 Android：Android Studio + SDK
- 仓库已 `git clone`，进入 `mobile/` 目录

---

## 2. 安装与运行

```bash
cd mobile
npm ci                      # 按 package-lock 精确安装依赖
```

### 本地开发构建（最快）

```bash
# iOS（模拟器或已连接的真机，macOS）
npx expo run:ios

# Android（模拟器或已连接的真机）
npx expo run:android
```

首次会编译原生工程并把 **dev client** 装到设备上，之后日常开发只需：

```bash
npx expo start          # 启动 Metro，用设备上的 dev client 扫码/连接
```

### 用 EAS 出可分发的安装包（可选）

如果要给别人装、或在真机上测生物识别 / 终端，用 EAS 出 development 或 production
构建：

```bash
npm i -g eas-cli
eas build --profile development --platform ios      # 或 android
```

把产物（.ipa / .apk）装到设备即可。

> 提示：生物识别和软键盘等行为只能在**真机**上完整验证，模拟器仅能验证界面。

---

## 3. 首次登录

打开 App 进入登录页，填三项：

| 字段 | 说明 | 示例 |
|------|------|------|
| 服务器地址 | 你的 Shepherd 后端 URL（带协议） | `https://shepherd.example.com` |
| 用户名 | 管理员账号 | `admin` |
| 密码 | 管理员密码 | `••••••••` |

点 **Sign in**。登录成功后，App 会把会话令牌存进系统安全区（iOS Keychain /
Android Keystore，经 `expo-secure-store`），服务器地址存进普通存储，下次打开自动恢复
登录，无需重输。

登录采用 **Bearer Token**：移动端登录时后端只在响应体里返回令牌（浏览器端仍是
HttpOnly Cookie，互不影响）。之后所有请求都带 `Authorization: Bearer <token>`。

**登录失败**会在按钮上方提示原因。后端对登录有限流与账号锁定（5 分钟内 10 次失败
触发），短时间多次输错会被暂时拒绝，稍后再试。

---

## 4. 功能一览

登录后进入**首页 = 服务器列表**。顶部栏右侧有 `Plugins`、`Settings`、`Log out`
三个入口。

### 4.1 服务器列表与监控（首页）
- 每台机器一行：在线状态点、名称、实时上下行速率、CPU / 内存占用。
- 在线的排在前面；离线行变灰显示 `offline`。
- 列表每 5 秒自动刷新；下拉可手动刷新。
- 点任意一行进入**服务器详情**。

### 4.2 服务器详情
展示该机器的指标，并提供动作按钮：
- **Open console** —— 打开远程终端（见 4.3）
- **Files** —— 浏览该机器的文件（见 4.4）
- **Run script** —— 在该机器上跑脚本（见 4.5）

### 4.3 远程终端（核心功能）
真正的交互式终端（xterm.js，支持颜色 / 光标 / TUI 程序如 `htop`、`vim`）：
- 顶部显示连接状态（connecting / connected / closed）。
- 底部有**隐藏输入框**：点终端区域会唤起软键盘，输入的字符实时发送到机器。
- 一条**控制键栏**：`Esc / Tab / Ctrl-C / Ctrl-D / Ctrl-Z / 方向键 / | / / / ~ / -`。
- 断开后用 **Reconnect** 重开一个新会话（PTY 不可续，旧会话不可恢复）；**Close**
  返回上一页。

### 4.4 文件浏览（只读）
- 顶部面包屑显示当前路径，点任意一段可跳转；非根目录有 `..` 返回上一级。
- 目录排在文件前，按名称排序；点目录进入，点文件进入**预览**。
- 预览：文本文件以等宽字体展示；二进制文件提示「Binary file — can't preview」；
  空文件显示 `(empty)`。
- 只读：不支持上传 / 下载 / 改名 / 删除（出于手机端误操作风险，暂不提供）。

### 4.5 脚本执行
从服务器详情的 **Run script** 进入（即「在这台机器上跑」）：
1. **脚本列表** —— 显示已保存脚本的名称与描述，点进入运行表单。
2. **运行表单** —— 按脚本定义渲染参数输入框（带默认值）；必填参数未填时
   **Run 会被拦截**并提示缺哪些。
3. **运行状态** —— 提交后跳到状态页，每 2 秒轮询，直到目标机器到达终态
   （done / success / failed / error / timeout / cancelled），显示状态与退出码。

> 说明：脚本输出基于 PTY，状态页目前只展示状态 / 退出码，不含实时输出文本。

### 4.6 插件管理（首页 → Plugins）
- **插件列表** —— 图标、名称、分类，右侧开关直接**启用 / 停用**。点进详情。
- **插件详情** —— 启停开关 + `Edit config`；若插件是 host-aware（按主机部署），
  额外有 `Hosts` 入口。
- **编辑配置** —— 以 JSON 文本编辑插件配置；保存前校验 JSON，非法会就地报错。
  敏感字段显示为 `"***"`，**保持原样保存即可保留服务端已存的密钥**。
- **主机部署（host-aware 插件）** —— 列出各主机的部署状态（含失败原因）；顶部输入
  server id 可 **Deploy**；每行可 **Start / Stop / Restart / Refresh / Undeploy**。
  异步部署期间列表会自动轮询刷新。

### 4.7 设置与生物识别锁（首页 → Settings）
- **Require biometric unlock** 开关：开启后用 Face ID / Touch ID / 指纹给 App 上锁。
  仅当设备有生物识别硬件并已录入时可开启，否则开关置灰并提示。
- **Sign out**：登出并清除本机令牌，回到登录页。

---

## 5. 生物识别锁的行为

开启后：
- **冷启动**（进程重建）时要求验证一次；验证通过前不会显示任何受保护内容。
- 从**后台返回**且离开超过 **30 秒**时要求重新验证（短暂切出，如下拉通知栏，不会触发）。
- 验证失败停在锁屏，可点 **Unlock** 重试；失败后会出现 **Sign out** 可直接登出。
- 降级用系统设备密码（OS 默认行为）。
- 锁只是「进入 App 前的闸门」，令牌本身始终存在系统安全区。

---

## 6. 退出登录

首页或设置页的 **Log out / Sign out**：会向后端吊销当前会话，并清掉本机保存的令牌，
回到登录页。任何请求遇到 **401**（令牌失效）也会自动登出回登录页。

---

## 7. 常见问题

| 现象 | 原因与处理 |
|------|-----------|
| 终端 / 锁屏打不开，或报缺少原生模块 | 用的是 Expo Go。改用 development build（`npx expo run:ios/android`）。 |
| 终端一直 connecting | 服务器地址 / 网络不通，或令牌过期。检查 URL、确认能访问后端；必要时重新登录。 |
| 登录提示被拒/锁定 | 触发了登录限流（5 分钟 10 次失败）。等几分钟再试。 |
| 设置里生物识别开关是灰的 | 设备没有生物识别硬件，或系统里还没录入 Face ID / 指纹。先在系统设置里录入。 |
| 文件预览显示「Binary」 | 该文件不是文本，只读端不预览二进制。 |
| 列表数据不更新 | 列表本身 5 秒轮询；可下拉手动刷新；长期不动多半是令牌失效，重登一次。 |

---

## 8. 开发者备注

- 校验三件套（无头）：`npm run typecheck`、`npm run lint`、`npm test`。
- 路由：expo-router，文件式路由根在 `src/app/`；登录组 `(auth)/`、主应用组 `(app)/`。
- 状态：`zustand`（`src/store/auth.ts` 会话、`src/store/lock.ts` 锁）；数据请求用
  `@tanstack/react-query` + `src/api/authed.ts`（自动带 Bearer，遇 401 清会话）。
- 加依赖后务必同步 lock：`npm install --package-lock-only` → `rm -rf node_modules &&
  npm ci`（CI 用 `npm ci`，lock 不同步会失败）。

---

## 9. 未包含的功能

- **推送通知（R7）**：服务器事件（如机器上线 / 下线、告警）推送到手机。需要新增后端
  （设备令牌表 + 事件→Expo 推送分发 + 上线/离线事件发射），且投递只能真机验证，已规划
  为后续独立一轮，当前版本不含。
- 文件写操作（上传 / 下载 / 改名 / 删除）、多目标脚本运行、脚本实时输出、插件日志流。
