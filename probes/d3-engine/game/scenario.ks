; Original, non-commercial KAG scenario for the KRKR2 Web D3 gate.
[linemode]

*start
[jump target=*intro]
[probe phase=error text="The KAG jump tag failed."]

*intro
[probe phase=intro text="A real .ks scenario is now running."]
[wait]

[macro name=emit]
[probe phase=%phase text=%text]
[endmacro]

[if exp="1 == 1"]
[emit phase=condition text="Macro and condition tags passed."]
[else]
[probe phase=error text="The KAG condition tag failed."]
[endif]

; krkr2web: numbered WebP sequence. Each click-driven open predicts its
; numeric successor (engine patch 0079), the page prefetches it into the
; segment / image parks (play/prefetch.js), and the next open consumes the
; park and rides the off-thread WebP decode chain. The pump stops at every
; [wait], so one click advances one image.
[image storage="pfbg0001.png" layer=0 page=back]
[wait]
[image storage="pfbg0002.png" layer=0 page=back]
[wait]
[image storage="pfbg0003.png" layer=0 page=back]
[wait]
[image storage="pfbg0004.png" layer=0 page=back]
[wait]
[image storage="pfbg0005.png" layer=0 page=back]
[wait]
[image storage="pfbg0006.png" layer=0 page=back]
[emit phase=prefetch text="Numbered WebP prefetch sequence finished."]

[choice]

*left
[probe phase=branch branch=left text="You followed the light."]
[checkpoint branch=left]
[probe phase=restored branch=left text="The left route resumed from KAG state."]
[end]

*right
[probe phase=branch branch=right text="You listened to the rain."]
[checkpoint branch=right]
[probe phase=restored branch=right text="The right route resumed from KAG state."]
[end]
