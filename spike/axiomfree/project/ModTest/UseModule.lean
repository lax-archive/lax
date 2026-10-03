module

public import ModTest.Hidden

public section

-- (1) non-public def in a type position
theorem useHiddenDef : ModTest.hiddenDef := fun _ => rfl

-- (2) non-public theorem in a term position
theorem useHiddenThm : ModTest.pubDef := ModTest.hiddenThm

-- (3) control: public def + public theorem
theorem usePub : ModTest.pubDef := ModTest.pubThmOverPub

end

-- (4) public def, not exposed: unfolding in an importer
theorem useNotExposed : ModTest.notExposed := fun _ => rfl

-- (5) public abbrev
theorem useAbbrev : ModTest.abbrevDef := fun _ => rfl

-- (6) @[expose] public def
theorem useExposed : ModTest.exposedDef := fun _ => rfl
