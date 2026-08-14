#include "ncbind.hpp"
#include "MsgIntf.h"

// krkr2web: minimal layerExDraw stub. The real plugin needs libgdiplus + Cocos2D
// (not available on the krkrsdl2 web target). All methods are no-ops registered
// via RawCallback (any argument signature accepted) so game scripts such as the
// exroll logo roll can proceed; actual drawing will be implemented later.

#define NCB_MODULE_NAME TJS_W("layerExDraw.dll")

class LayerExDrawStub {
public:
    LayerExDrawStub() {}

    static tjs_error noop(tTJSVariant *result, tjs_int numparams,
                          tTJSVariant **param, iTJSDispatch2 *objthis) {
        if(result) result->Clear();
        return TJS_S_OK;
    }

    static tjs_error measureString(tTJSVariant *result, tjs_int numparams,
                                   tTJSVariant **param, iTJSDispatch2 *objthis) {
        if(result) {
            tjs_int w = 16, h = 16;
            if(numparams >= 1) {
                ttstr s(*param[0]);
                w = s.GetLen() * 16;
                if(w < 16) w = 16;
            }
            iTJSDispatch2 *dic = TJSCreateDictionaryObject();
            tTJSVariant vw(w), vh(h);
            dic->PropSet(TJS_MEMBERENSURE, TJS_W("width"), nullptr, &vw, dic);
            dic->PropSet(TJS_MEMBERENSURE, TJS_W("height"), nullptr, &vh, dic);
            *result = tTJSVariant(dic, dic);
            dic->Release();
        }
        return TJS_S_OK;
    }

    static tjs_error getBool(tTJSVariant *result, tjs_int numparams,
                             tTJSVariant **param, iTJSDispatch2 *objthis) {
        if(result) *result = (tjs_int)0;
        return TJS_S_OK;
    }

    static tjs_error setAny(tTJSVariant *result, tjs_int numparams,
                            tTJSVariant **param, iTJSDispatch2 *objthis) {
        return TJS_S_OK;
    }
};

NCB_ATTACH_CLASS_WITH_HOOK(LayerExDrawStub, Layer) {
    RawCallback(TJS_W("updateWhenDraw"), &Class::getBool, &Class::setAny, 0);
    RawCallback(TJS_W("smoothingMode"), &Class::getBool, &Class::setAny, 0);
    RawCallback(TJS_W("textRenderingHint"), &Class::getBool, &Class::setAny, 0);
    RawCallback(TJS_W("record"), &Class::getBool, &Class::setAny, 0);
    RawCallback(TJS_W("setViewTransform"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("resetViewTransform"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("rotateViewTransform"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("scaleViewTransform"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("translateViewTransform"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("setTransform"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("resetTransform"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("rotateTransform"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("scaleTransform"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("translateTransform"), &Class::noop, (int)0, 0);
    // clear removed: the game assigns .clear on Layer instances at runtime
    // (custom.tjs CustomShowDateLayer.setup), and a class member named clear
    // would make that PropSet throw. Game-side .clear() calls resolve to the
    // game's own TJS methods, matching vanilla Kirikiri 2 behavior.
    RawCallback(TJS_W("drawPath"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawArc"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawPie"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawBezier"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawBeziers"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawClosedCurve"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawClosedCurve2"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawCurve"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawCurve2"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawCurve3"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawEllipse"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawLine"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawLines"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawPolygon"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawRectangle"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawRectangles"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawPathString"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawString"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("measureString"), &Class::measureString, (int)0, 0);
    RawCallback(TJS_W("measureStringInternal"), &Class::measureString, (int)0, 0);
    RawCallback(TJS_W("drawImage"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawImageRect"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawImageStretch"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("drawImageAffine"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("getRecordImage"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("redrawRecord"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("saveRecord"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("loadRecord"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("saveImage"), &Class::noop, (int)0, 0);
    RawCallback(TJS_W("getColorRegionRects"), &Class::noop, (int)0, 0);
}
