package com.jason5545.mt2;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.view.Display;
import android.view.DisplayCutout;
import android.view.RoundedCorner;
import android.view.KeyEvent;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Monster Train 2 的全包 APK 殼（照 diceomancer-web 的 android/，Jason 10/17 要）：一個全螢幕 WebView，網頁與原版素材都從 APK 的 assets 讀，
 * 完全離線。
 *
 * 網址用 https://appassets.androidplatform.net/（WebViewAssetLoader 慣用的保留網域，不會連到外面），
 * shouldInterceptRequest 攔下來自己回檔案：
 *   1. 先找 getExternalFilesDir/web/ 的覆蓋檔（改程式碼時 adb push 進去，不用重裝 3 GB 的 APK；scripts/build-apk.mjs --code）；
 *   2. 再找 APK 的 assets（build/apk-web 的程式碼加 public/ 的原版素材）。
 *
 * 其他：
 *   - 觸控照原版：MT2 原版就支援觸控，網頁的 pointer 事件照滑鼠送（unity-cs2ts 的 attachInput），這裡不另做翻譯。
 *   - 返回鍵送 Esc（原版的取消／暫停選單）。
 *   - 要螢幕的最高更新率；遊戲中螢幕不休眠；沉浸式全螢幕（系統列從邊緣滑才出來）。
 *   - 螢幕的圓角與鏡頭挖孔：網頁從 MT2App.safeInsets() 讀，畫布右邊讓開（原版沒有 Screen.safeArea 的處理，Jason 10/18：圓角裁到最右邊的設定鈕）。
 *   - debug build 開 WebView 遠端除錯（chrome://inspect）。
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("png", "image/png");
        MIME.put("webp", "image/webp");
        MIME.put("jpg", "image/jpeg");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
        MIME.put("wasm", "application/wasm");
        MIME.put("ttf", "font/ttf");
        MIME.put("otf", "font/otf");
        MIME.put("glsl", "text/plain");
        MIME.put("txt", "text/plain");
        MIME.put("ogg", "audio/ogg");
        MIME.put("mp4", "video/mp4");
    }

    private WebView webView;
    private File overrideDir;
    /** 替視窗選的顯示模式的更新率（Hz），網頁從 MT2App.refreshRate() 讀 */
    private volatile float refreshRate = 60f;
    /** 左右邊緣往內會被圓角或挖孔蓋到的寬度（裝置像素，JSON），見 updateSafeInsets */
    private volatile String safeInsets = "{\"left\":0,\"right\":0}";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        requestHighestRefreshRate(window);

        File ext = getExternalFilesDir(null);
        overrideDir = ext == null ? null : new File(ext, "web");
        // 覆蓋資料夾比這次安裝舊就不讀：在手機上直接裝新 APK 時 build-apk.mjs 清不到它，不擋的話舊的程式碼會蓋過新 APK 裡的
        if (overrideDir != null && overrideDir.isDirectory()) {
            try {
                long installed = getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime;
                if (overrideDir.lastModified() < installed) overrideDir = null;
            } catch (Exception ignored) {
                // 查不到安裝時間就照舊
            }
        }

        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // 存檔
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // 不准放大：雙指縮放、雙擊放大、縮放鈕都關掉；字級固定 100%，不跟系統字型大小走
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " MT2App");
        webView.setWebViewClient(new AssetClient());
        // 只載自己的網頁（shouldOverrideUrlLoading 擋掉其他網域），注入的介面只有 quit、refreshRate、safeInsets
        webView.addJavascriptInterface(new AppBridge(), "MT2App");
        webView.setBackgroundColor(0xFF000000);
        webView.setOnApplyWindowInsetsListener((v, insets) -> {
            updateSafeInsets(insets);
            return v.onApplyWindowInsets(insets);
        });
        setContentView(webView);
        hideSystemBars();

        if (android.os.Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::sendBack);
        }
        if (savedInstanceState == null) webView.loadUrl(START_URL);
    }

    /** 選同解析度裡更新率最高的顯示模式，再把 preferredRefreshRate 也設上 */
    private void requestHighestRefreshRate(Window window) {
        Display display = getDisplay();
        if (display == null) return;
        Display.Mode current = display.getMode();
        Display.Mode best = current;
        for (Display.Mode m : display.getSupportedModes()) {
            boolean sameSize = m.getPhysicalWidth() == current.getPhysicalWidth() && m.getPhysicalHeight() == current.getPhysicalHeight();
            if (sameSize && m.getRefreshRate() > best.getRefreshRate()) best = m;
        }
        WindowManager.LayoutParams lp = window.getAttributes();
        lp.preferredDisplayModeId = best.getModeId();
        lp.preferredRefreshRate = best.getRefreshRate();
        window.setAttributes(lp);
        refreshRate = best.getRefreshRate();
    }

    /**
     * 左右邊緣往內多深會被圓角或挖孔蓋到。橫向時畫布貼齊上下緣，角落那一點 (x, 0) 要在圓角裡面，x 至少是圓角半徑；
     * 挖孔照 DisplayCutout 的 safeInset。兩邊給同一個值（橫向可能轉成任一邊）；要讓哪邊由網頁決定（目前只讓右邊的設定齒輪）。
     */
    private void updateSafeInsets(WindowInsets insets) {
        int side = 0;
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            for (int pos : new int[] {RoundedCorner.POSITION_TOP_LEFT, RoundedCorner.POSITION_TOP_RIGHT, RoundedCorner.POSITION_BOTTOM_RIGHT, RoundedCorner.POSITION_BOTTOM_LEFT}) {
                RoundedCorner rc = insets.getRoundedCorner(pos);
                if (rc != null) side = Math.max(side, rc.getRadius());
            }
        }
        DisplayCutout cutout = insets.getDisplayCutout();
        if (cutout != null) side = Math.max(side, Math.max(cutout.getSafeInsetLeft(), cutout.getSafeInsetRight()));
        safeInsets = "{\"left\":" + side + ",\"right\":" + side + "}";
    }

    private void hideSystemBars() {
        WindowInsetsController c = getWindow().getInsetsController();
        if (c == null) return;
        c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
        c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        getWindow().getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
    }

    /** 返回鍵 → Esc（attachInput 聽 window 的 keydown／keyup） */
    private void sendBack() {
        webView.evaluateJavascript(
            "for (const t of ['keydown','keyup']) window.dispatchEvent(new KeyboardEvent(t, { key: 'Escape', code: 'Escape' }))", null);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // Android 12 以前（沒有 OnBackInvokedDispatcher）
        if (keyCode == KeyEvent.KEYCODE_BACK && android.os.Build.VERSION.SDK_INT < 33) {
            sendBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        hideSystemBars();
    }

    @Override
    protected void onDestroy() {
        webView.destroy();
        super.onDestroy();
    }

    /** 給網頁呼叫的介面（window.MT2App）；JavascriptInterface 跑在 WebView 的執行緒，關 Activity 要回到 UI 執行緒 */
    private final class AppBridge {
        @JavascriptInterface
        public void quit() {
            runOnUiThread(MainActivity.this::finishAndRemoveTask);
        }

        /** 螢幕更新率：遊戲的 Screen.currentResolution、垂直同步與目標幀率清單用 */
        @JavascriptInterface
        public float refreshRate() {
            return refreshRate;
        }

        /** 左右邊緣往內會被蓋到的寬度（裝置像素，JSON {"left","right"}）：螢幕圓角與鏡頭挖孔 */
        @JavascriptInterface
        public String safeInsets() {
            return safeInsets;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onRestoreInstanceState(Bundle savedInstanceState) {
        super.onRestoreInstanceState(savedInstanceState);
        webView.restoreState(savedInstanceState);
    }

    private final class AssetClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!HOST.equals(uri.getHost())) return null;
            String path = uri.getPath();
            if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
            path = Uri.decode(path).substring(1);
            if (path.contains("..")) return notFound();
            InputStream in = open(path);
            if (in == null) return notFound();
            WebResourceResponse r = new WebResourceResponse(mimeOf(path), null, in);
            r.setResponseHeaders(headers());
            return r;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // 遊戲裡沒有要開的外部連結；其他網域一律不開
            return !HOST.equals(request.getUrl().getHost());
        }
    }

    private InputStream open(String path) {
        if (overrideDir != null) {
            File f = new File(overrideDir, path);
            if (f.isFile()) {
                try {
                    return new FileInputStream(f);
                } catch (IOException ignored) {
                    // 讀不到覆蓋檔就用 APK 裡的
                }
            }
        }
        try {
            return getAssets().open(path);
        } catch (IOException e) {
            return null;
        }
    }

    private static String mimeOf(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot < 0 ? "" : path.substring(dot + 1).toLowerCase(Locale.ROOT);
        String m = MIME.get(ext);
        return m == null ? "application/octet-stream" : m;
    }

    private static Map<String, String> headers() {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        return h;
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers(), null);
    }
}
