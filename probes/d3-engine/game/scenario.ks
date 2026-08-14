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
