// Monster Train 2 的 Android 殼（照 diceomancer-web 的全包 APK，Jason 10/17 要）：原生 WebView 從 APK 內部讀網頁與原版素材，完全離線。
// 建置一律跑 ../scripts/build-apk.mjs（先 vite build 程式碼，再組 APK、裝到手機）。
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "mt2"
include(":app")
