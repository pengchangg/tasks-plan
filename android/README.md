# Android APK（WebView 壳）

整个 APK 只有一个 Activity：用 WebView 加载服务器**同源**的远端页面，前端一行没改。
不要把 `dist/` 打进 APK 用本地地址加载——那样每个 API 都变跨源，`sameOrigin` 直接
`403 origin_mismatch`，`SameSite=Lax` 的 `growjoy_session` 也不会随请求发出。

## 出包

Gitea Actions → **Android APK** → Run workflow（手动触发，不跟 push 联动）。跑完在
run 页面下载 `growjoy-apk` 产物，就是 `app-debug.apk`，手机直接侧载。
产物是 debug 签名，够自己家装；要发 release 得配自己的 keystore。

首次运行现装工具链（Temurin JDK 17 + Android SDK platform 34/build-tools + Gradle 8.9，
约 1 GB），之后靠 Actions 缓存，一次构建两分钟左右。

## 改地址

`app/src/main/java/com/growjoy/app/MainActivity.java` 顶部的 `START_URL`：

- 默认 `http://192.168.0.208:9080/child`——内网直连，免 Basic Auth、免证书，手机必须连家里 WiFi。
- 换成 `https://growjoy.moxao.cn` 可以外网使用，但该入口前有 Caddy Basic Auth，
  需要在 `onReceivedHttpAuthRequest` 里弹口令输入框，否则一进去就是 401。
  不要用 `https://growjoy.homelab.com`：那是 Caddy 内部 CA，手机不信任。

`AndroidManifest.xml` 里的 `usesCleartextTraffic="true"` 只为内网 http 入口；全站上 HTTPS 后可以去掉。

## 本地打包（已验证，1 分 12 秒）

需要 JDK 17+、Android SDK（platform 34 + build-tools 34.0.0）、Gradle 8.9：

```bash
cd android
echo "sdk.dir=$HOME/.android-sdk" > local.properties   # 或 ANDROID_HOME
gradle assembleDebug                                   # 产物 app/build/outputs/apk/debug/app-debug.apk
```

本机实测可以用的是 JDK 21（AGP 8.6 支持 17+）。

### 墙内网络

本机直连 `services.gradle.org`、`repo.maven.apache.org`、`api.adoptium.net`、`github.com`
都不通（TLS 握手直接被断），所以本地装工具链要换源，Gradle 依赖也走阿里云：

| 东西 | 源 |
|---|---|
| JDK | `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/linux/` |
| Gradle 8.9 | `https://mirrors.cloud.tencent.com/gradle/gradle-8.9-bin.zip` |
| Android SDK | `https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip`（dl.google.com 是通的）|
| Maven 依赖 | `https://maven.aliyun.com/repository/{google,central,gradle-plugin}` |

Gradle 依赖换源只写在本机 `~/.gradle/init.d/aliyun-mirror.gradle`（清空 `settingsEvaluated`
里的仓库列表再填阿里云），别提交进仓库——CI 或墙外环境不需要它。

## 已知边界

- 上传走系统文件选择器（`ACTION_GET_CONTENT`），可以直接选相册里刚拍的照片/视频；
  没有内嵌相机。
- 页面状态靠 `saveState`，进程被系统杀掉后重新打开会回到首页。
- 只支持竖屏。
