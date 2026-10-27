package com.passersby.scorerecognizer;

import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 固定 WebView 文字缩放为 100%，避免系统超大字体把手机端布局撑坏
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                WebSettings settings = getBridge().getWebView().getSettings();
                settings.setTextZoom(100);
            }
        } catch (Throwable ignored) {
            // 拿不到 WebView 时使用系统默认缩放
        }
    }
}
