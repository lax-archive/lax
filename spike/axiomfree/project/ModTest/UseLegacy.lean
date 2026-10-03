-- No `module` header: legacy import of a `module` file.
import ModTest.Hidden

theorem legacyUseHiddenDef : ModTest.hiddenDef := fun _ => rfl

theorem legacyUseHiddenThm : ModTest.pubDef := ModTest.hiddenThm

theorem legacyUsePub : ModTest.pubDef := ModTest.pubThmOverPub

theorem legacyUseNotExposed : ModTest.notExposed := fun _ => rfl

theorem legacyUseAbbrev : ModTest.abbrevDef := fun _ => rfl

theorem legacyUseExposed : ModTest.exposedDef := fun _ => rfl
