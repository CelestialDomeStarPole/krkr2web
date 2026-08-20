#include "tjsCommHead.h"
#include "ncbind.hpp"

#define NCB_MODULE_NAME TJS_W("windowEx.dll")

namespace {

struct tNotification {
    const tjs_char *Name;
    tjs_int Number;
};

const tNotification Notifications[] = {
    {TJS_W("NULL"), 0x0000},
    {TJS_W("CREATE"), 0x0001},
    {TJS_W("DESTROY"), 0x0002},
    {TJS_W("MOVE"), 0x0003},
    {TJS_W("SIZE"), 0x0005},
    {TJS_W("ACTIVATE"), 0x0006},
    {TJS_W("SETFOCUS"), 0x0007},
    {TJS_W("KILLFOCUS"), 0x0008},
    {TJS_W("CLOSE"), 0x0010},
    {TJS_W("PAINT"), 0x000f},
    {TJS_W("KEYDOWN"), 0x0100},
    {TJS_W("KEYUP"), 0x0101},
    {TJS_W("CHAR"), 0x0102},
    {TJS_W("SYSKEYDOWN"), 0x0104},
    {TJS_W("SYSKEYUP"), 0x0105},
    {TJS_W("SYSCHAR"), 0x0106},
    {TJS_W("COMMAND"), 0x0111},
    {TJS_W("TIMER"), 0x0113},
    {TJS_W("MOUSEMOVE"), 0x0200},
    {TJS_W("LBUTTONDOWN"), 0x0201},
    {TJS_W("LBUTTONUP"), 0x0202},
    {TJS_W("LBUTTONDBLCLK"), 0x0203},
    {TJS_W("RBUTTONDOWN"), 0x0204},
    {TJS_W("RBUTTONUP"), 0x0205},
    {TJS_W("MBUTTONDOWN"), 0x0207},
    {TJS_W("MBUTTONUP"), 0x0208},
    {TJS_W("MOUSEWHEEL"), 0x020a},
    {TJS_W("MOUSEHWHEEL"), 0x020e},
    {TJS_W("TOUCH"), 0x0240},
    {TJS_W("DISPLAYCHANGE"), 0x007e},
    {TJS_W("CONTEXTMENU"), 0x007b},
    {TJS_W("DROPFILES"), 0x0233},
    {TJS_W("CLIPBOARDUPDATE"), 0x031d},
};

tjs_int GetNotificationNum(ttstr name) {
    ttstr normalized = name.AsUpperCase();
    for(const auto &notification : Notifications) {
        if(normalized == notification.Name) return notification.Number;
    }
    return -1;
}

ttstr GetNotificationName(tjs_int number) {
    for(const auto &notification : Notifications) {
        if(number == notification.Number) return ttstr(notification.Name);
    }
    return ttstr();
}

bool SetMessageHook(bool, tjs_int) {
    // Browser input is already normalized into KRKR events by SDL. Windows
    // message hooks have no second event source to enable on this platform.
    return false;
}

tjs_int SetDispMode(tjs_int) {
    return 0;
}

} // namespace

NCB_ATTACH_FUNCTION(getNotificationNum, Window, GetNotificationNum);
NCB_ATTACH_FUNCTION(getNotificationName, Window, GetNotificationName);
NCB_ATTACH_FUNCTION(setMessageHook, Window, SetMessageHook);
NCB_ATTACH_FUNCTION(setDispMode, Window, SetDispMode);
