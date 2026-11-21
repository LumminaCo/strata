# 0003. Embed the WebView2 bootstrapper in Windows installers

Accepted by the project owner.

Tauri's Windows installer embeds the WebView2 bootstrapper. Offline installation assumes WebView2 Evergreen is already present, as on the supported Windows baseline. The bootstrapper needs a network connection when the runtime is missing. This keeps the installer compatible with the size budget. [Tauri installer modes](https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options)
