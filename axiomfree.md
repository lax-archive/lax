I have found what I believe to be a better design. I would be interested what you think.

For conditional proofs in the proof package, I agree that the best is to represent assumptions as hypotheses. As a bonus, it nice and mechanical to compose partial results, say A->B and B->C from independent submissions into A->C.

In the concept package, I believe the best mechanism to make claims is def MyStatement : Prop. In contrast, theorem by sorry looks to me like incomplete work, and proof_wanted implies, that there is no proof yet, which is not necessary the case.

You also convinced me that kernel-only checks are required to gain the full trust of the lean community, I therefore came up with the following idea: Lax uses meta-programming to determine a proof network recording which statements are proven relative to which other statements on the website. This is the key place where the user currently has to trust lax.

This proof network consists of various (assumption_1, ..., assumption_k -> conclusion) hyperedges. On a regular basis, lax could publish and check a (challenge, proof) comparator input  (https://github.com/leanprover/comparator) that certifies that all hyperedges in the proof network are true. Moreover, for any (assumption_0, ..., assumption_k -> conclusion) implied by this network, the lax cli or website should offer an export mechanism to get a standalone (challenge, proof) certificate.

I believe this would reduce all claims shown on the website to kernel-only trust, and get rid of all axioms. 

perhaps we can even replace parts of our own handrolled inspector mechanism with the better maintained comparator?

https://palomar-registry.org/ also uses comparator to check submissions.
we might want to check how they work with frozen submission ecosystem interacting with continuously changing comparator

----------------------

implementing this requires us to bump the version of the spec.
we probably want both versions to coexist (with and without axioms), and do the kernel-only comparator work only for those submissions on the new mechanism.


we have to carefully make a plan for this, if we really want to do it. give me your assessment of the strategy and if and how we can make it.
