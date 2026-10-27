package com.growjoy.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 整个 APK 就是一个 WebView：加载服务器同源的远端页面，不做任何本地打包。
 * 必须同源——本地加载 dist/ 会让每个 API 变成跨源，sameOrigin 中间件直接 403，
 * SameSite=Lax 的 growjoy_session 也不会随请求发出。
 */
public class MainActivity extends Activity {

    // 唯一需要改的地方。换成 https://growjoy.moxao.cn 时要额外处理 Caddy Basic Auth。
    private static final String START_URL = "http://192.168.0.208:9080/child";

    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        web = new WebView(this);
        setContentView(web);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        web.setWebViewClient(new WebViewClient());

        // 作业/证据上传走 <input type="file">：不实现 onShowFileChooser 则点了完全无反应。
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                String[] accept = params.getAcceptTypes();
                boolean video = accept != null && accept.length > 0
                        && accept[0] != null && accept[0].startsWith("video");
                // 系统相册/文件选择器：现代 Android 的选择器里可以直接拍照或录像。
                intent.setType(video ? "video/*" : "image/*");
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
                return true;
            }
        });

        if (state == null) {
            web.loadUrl(START_URL);
        } else {
            web.restoreState(state);
        }
    }

    private static final int REQ_FILE = 1;

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE || filePathCallback == null) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int i = 0; i < count; i++) {
                    result[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        filePathCallback.onReceiveValue(result);
        filePathCallback = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
