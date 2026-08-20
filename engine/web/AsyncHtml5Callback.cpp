#if defined(__EMSCRIPTEN__) && defined(__EMSCRIPTEN_PTHREADS__)

#include <emscripten/html5.h>
#include <emscripten/proxying.h>
#include <pthread.h>

#include <cstdlib>
#include <cstring>

namespace {

using tWebEventCallback = EM_BOOL (*)(int, void *, void *);

struct tAsyncCallbackArgs {
    tWebEventCallback Callback;
    int EventType;
    void *UserData;
    size_t EventSize;
    unsigned char EventData[1];
};

size_t GetEventSize(int event_type) {
    switch(event_type) {
    case EMSCRIPTEN_EVENT_KEYPRESS:
    case EMSCRIPTEN_EVENT_KEYDOWN:
    case EMSCRIPTEN_EVENT_KEYUP:
        return sizeof(EmscriptenKeyboardEvent);
    case EMSCRIPTEN_EVENT_CLICK:
    case EMSCRIPTEN_EVENT_MOUSEDOWN:
    case EMSCRIPTEN_EVENT_MOUSEUP:
    case EMSCRIPTEN_EVENT_DBLCLICK:
    case EMSCRIPTEN_EVENT_MOUSEMOVE:
    case EMSCRIPTEN_EVENT_MOUSEENTER:
    case EMSCRIPTEN_EVENT_MOUSELEAVE:
    case EMSCRIPTEN_EVENT_MOUSEOVER:
    case EMSCRIPTEN_EVENT_MOUSEOUT:
        return sizeof(EmscriptenMouseEvent);
    case EMSCRIPTEN_EVENT_WHEEL:
        return sizeof(EmscriptenWheelEvent);
    case EMSCRIPTEN_EVENT_RESIZE:
    case EMSCRIPTEN_EVENT_SCROLL:
    case EMSCRIPTEN_EVENT_CANVASRESIZED:
        return sizeof(EmscriptenUiEvent);
    case EMSCRIPTEN_EVENT_BLUR:
    case EMSCRIPTEN_EVENT_FOCUS:
    case EMSCRIPTEN_EVENT_FOCUSIN:
    case EMSCRIPTEN_EVENT_FOCUSOUT:
        return sizeof(EmscriptenFocusEvent);
    case EMSCRIPTEN_EVENT_DEVICEORIENTATION:
        return sizeof(EmscriptenDeviceOrientationEvent);
    case EMSCRIPTEN_EVENT_DEVICEMOTION:
        return sizeof(EmscriptenDeviceMotionEvent);
    case EMSCRIPTEN_EVENT_ORIENTATIONCHANGE:
        return sizeof(EmscriptenOrientationChangeEvent);
    case EMSCRIPTEN_EVENT_FULLSCREENCHANGE:
        return sizeof(EmscriptenFullscreenChangeEvent);
    case EMSCRIPTEN_EVENT_POINTERLOCKCHANGE:
        return sizeof(EmscriptenPointerlockChangeEvent);
    case EMSCRIPTEN_EVENT_VISIBILITYCHANGE:
        return sizeof(EmscriptenVisibilityChangeEvent);
    case EMSCRIPTEN_EVENT_TOUCHSTART:
    case EMSCRIPTEN_EVENT_TOUCHEND:
    case EMSCRIPTEN_EVENT_TOUCHMOVE:
    case EMSCRIPTEN_EVENT_TOUCHCANCEL:
        return sizeof(EmscriptenTouchEvent);
    case EMSCRIPTEN_EVENT_GAMEPADCONNECTED:
    case EMSCRIPTEN_EVENT_GAMEPADDISCONNECTED:
        return sizeof(EmscriptenGamepadEvent);
    case EMSCRIPTEN_EVENT_BATTERYCHARGINGCHANGE:
    case EMSCRIPTEN_EVENT_BATTERYLEVELCHANGE:
        return sizeof(EmscriptenBatteryEvent);
    default:
        return 0;
    }
}

void RunAsyncCallback(void *opaque) {
    auto *args = static_cast<tAsyncCallbackArgs *>(opaque);
    args->Callback(args->EventType,
                   args->EventSize ? args->EventData : nullptr,
                   args->UserData);
    std::free(args);
}

} // namespace

// Emscripten's stock HTML5 bridge synchronously proxies browser events to the
// application pthread. KRKR2 can legitimately be suspended on an asynchronous
// XP3/IndexedDB read at that point, creating a main-thread <-> engine-thread
// proxy cycle. Queue a private copy instead; SDL consumes it on the next engine
// turn, matching the native KRKR event-pump model.
extern "C" void _emscripten_run_callback_on_thread(
    pthread_t target, tWebEventCallback callback, int event_type,
    void *event_data, void *user_data) {
    const size_t event_size = event_data ? GetEventSize(event_type) : 0;
    const size_t allocation_size = sizeof(tAsyncCallbackArgs) +
        (event_size > 0 ? event_size - 1 : 0);
    auto *args = static_cast<tAsyncCallbackArgs *>(std::malloc(allocation_size));
    if(!args) return;

    args->Callback = callback;
    args->EventType = event_type;
    args->UserData = user_data;
    args->EventSize = event_size;
    if(event_size) std::memcpy(args->EventData, event_data, event_size);

    em_proxying_queue *queue = emscripten_proxy_get_system_queue();
    if(!emscripten_proxy_async(queue, target, RunAsyncCallback, args)) {
        std::free(args);
    }
}

#endif
