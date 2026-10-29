// assets 來自兩個地方，都不進版控：
//   ../build/apk-web  vite 產生的程式碼（index.html、assets/；MT2_APK=1 時不複製 public/）
//   ../public         原版素材與資料（public/game/，npm run import 產生）
plugins {
    id("com.android.application")
}

android {
    namespace = "com.jason5545.mt2"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.jason5545.mt2"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "2.2.1-web"
    }

    sourceSets {
        getByName("main") {
            assets.srcDirs("../../build/apk-web", "../../public")
            // 圖示的前景 PNG（scripts/app_icon.py 從原版 MonsterTrain2.exe 抽出，不進版控）
            res.srcDirs("src/main/res", "../../build/apk-res")
        }
    }

    androidResources {
        // 已經壓縮過的格式不再壓（打包快、讀取不用解壓）；json、glsl 照常壓縮
        noCompress += listOf("png", "webp", "jpg", "ogg", "mp4", "wasm", "ttf", "otf")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
