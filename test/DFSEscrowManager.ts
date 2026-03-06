import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("DFSEscrowManager - Aave Phase 1", function () {
    const usdc = (v: string) => ethers.parseUnits(v, 6);

    async function deployFixture() {
        const [owner, organizer, participant1, participant2, contributor, outsider] = await ethers.getSigners();

        const MockToken = await ethers.getContractFactory("MockToken");
        const mockToken = await MockToken.deploy();

        const MockAavePool = await ethers.getContractFactory("MockAavePool");
        const mockAavePool = await MockAavePool.deploy();
        const poolAddress = await mockAavePool.getAddress();

        const MockAToken = await ethers.getContractFactory("MockAToken");
        const mockAToken = await MockAToken.deploy("Mock Aave USDC", "maUSDC", poolAddress);
        const aTokenAddress = await mockAToken.getAddress();
        const tokenAddress = await mockToken.getAddress();

        await mockAavePool.addAsset(tokenAddress, aTokenAddress);

        const DFSEscrowManager = await ethers.getContractFactory("DFSEscrowManager");
        const dfsEscrowManager = await DFSEscrowManager.deploy();

        await dfsEscrowManager.connect(owner).setAllowedPool(poolAddress, true);
        await dfsEscrowManager.connect(owner).setAllowedToken(tokenAddress, true);
        await dfsEscrowManager.connect(owner).setATokenForAsset(tokenAddress, aTokenAddress);
        await dfsEscrowManager.connect(owner).addAuthorizedCreator(organizer.address);

        return {
            dfsEscrowManager,
            mockToken,
            mockAavePool,
            mockAToken,
            tokenAddress,
            poolAddress,
            aTokenAddress,
            owner,
            organizer,
            participant1,
            participant2,
            contributor,
            outsider,
        };
    }

    async function createEscrow(
        fixture: Awaited<ReturnType<typeof deployFixture>>,
        options?: {
            pool?: string;
            overflowRecipient?: string;
            dues?: bigint;
            maxParticipants?: bigint;
            leagueName?: string;
            endTime?: number;
        }
    ) {
        const dues = options?.dues ?? usdc("100");
        const maxParticipants = options?.maxParticipants ?? 10n;
        const leagueName = options?.leagueName ?? "Week 1";
        const pool = options?.pool ?? fixture.poolAddress;
        const overflowRecipient = options?.overflowRecipient ?? ethers.ZeroAddress;
        const endTime = options?.endTime ?? (await time.latest()) + 7200;

        await fixture.dfsEscrowManager
            .connect(fixture.organizer)
            .createEscrow(
                fixture.tokenAddress,
                dues,
                endTime,
                leagueName,
                maxParticipants,
                overflowRecipient,
                pool
            );

        return { dues, endTime };
    }

    describe("Fixture setup and compatibility updates (K)", function () {
        it("uses Aave mocks and constructor without args", async function () {
            const { dfsEscrowManager, owner, poolAddress, tokenAddress, aTokenAddress } = await loadFixture(deployFixture);

            expect(await dfsEscrowManager.nextEscrowId()).to.equal(1n);
            expect(await dfsEscrowManager.isAuthorizedCreator(owner.address)).to.equal(true);
            expect(await dfsEscrowManager.allowedPools(poolAddress)).to.equal(true);
            expect(await dfsEscrowManager.allowedTokens(tokenAddress)).to.equal(true);
            expect(await dfsEscrowManager.aTokenForAsset(tokenAddress)).to.equal(aTokenAddress);
        });

        it("EscrowCreated emits pool and getEscrowDetails exposes new fields", async function () {
            const fixture = await loadFixture(deployFixture);
            const { dues, endTime } = await createEscrow(fixture, { pool: fixture.poolAddress, leagueName: "EventField" });

            await expect(
                fixture.dfsEscrowManager
                    .connect(fixture.organizer)
                    .createEscrow(
                        fixture.tokenAddress,
                        dues,
                        endTime + 7200,
                        "EventField2",
                        10,
                        ethers.ZeroAddress,
                        fixture.poolAddress
                    )
            )
                .to.emit(fixture.dfsEscrowManager, "EscrowCreated")
                .withArgs(2, fixture.organizer.address, fixture.poolAddress, fixture.tokenAddress, dues, endTime + 7200);

            const details = await fixture.dfsEscrowManager.getEscrowDetails(1);
            expect(details.pool).to.equal(fixture.poolAddress);
            expect(details.escrowBalance).to.equal(0n);
            expect(details.invested).to.equal(false);
            expect(details.principalInvested).to.equal(0n);
            expect(details.withdrawn).to.equal(false);
        });
    });

    describe("A) Basic lifecycle (no yield)", function () {
        it("creates with pool=0, joins, and distributes from escrowBalance", async function () {
            const fixture = await loadFixture(deployFixture);
            const { dues, endTime } = await createEscrow(fixture, {
                pool: ethers.ZeroAddress,
                overflowRecipient: fixture.contributor.address,
                dues: usdc("10"),
            });

            await fixture.mockToken.mint(fixture.participant1.address, dues);
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), dues);
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);

            let details = await fixture.dfsEscrowManager.getEscrowDetails(1);
            expect(details.escrowBalance).to.equal(dues);

            await time.increaseTo(endTime + 1);

            const payout = usdc("7");
            const expectedOverflow = dues - payout;
            const overflowBefore = await fixture.mockToken.balanceOf(fixture.contributor.address);

            await fixture.dfsEscrowManager
                .connect(fixture.organizer)
                .distributeWinnings(1, [fixture.participant1.address], [payout]);

            details = await fixture.dfsEscrowManager.getEscrowDetails(1);
            expect(details.escrowBalance).to.equal(0n);
            expect(details.payoutsComplete).to.equal(true);
            expect(await fixture.mockToken.balanceOf(fixture.contributor.address)).to.equal(overflowBefore + expectedOverflow);
        });
    });

    describe("B) Basic lifecycle (with Aave, single escrow)", function () {
        it("invests, accrues yield, withdraws, then distributes with overflow", async function () {
            const fixture = await loadFixture(deployFixture);
            const { dues, endTime } = await createEscrow(fixture, {
                pool: fixture.poolAddress,
                overflowRecipient: fixture.contributor.address,
                dues: usdc("50"),
            });

            const manager = await fixture.dfsEscrowManager.getAddress();
            const sponsorTopUp = usdc("20");
            const principal = dues * 2n + sponsorTopUp; // 120
            const yieldAmount = usdc("12");

            for (const p of [fixture.participant1, fixture.participant2]) {
                await fixture.mockToken.mint(p.address, dues);
                await fixture.mockToken.connect(p).approve(manager, dues);
                await fixture.dfsEscrowManager.connect(p).joinEscrow(1, 1);
            }

            await fixture.mockToken.mint(fixture.contributor.address, sponsorTopUp);
            await fixture.mockToken.connect(fixture.contributor).approve(manager, sponsorTopUp);
            await fixture.dfsEscrowManager.connect(fixture.contributor).addToPool(1, sponsorTopUp);

            await time.increaseTo(endTime + 1);

            await expect(fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1))
                .to.emit(fixture.dfsEscrowManager, "EscrowInvested")
                .withArgs(1, fixture.poolAddress, fixture.tokenAddress, principal);

            let details = await fixture.dfsEscrowManager.getEscrowDetails(1);
            expect(details.escrowBalance).to.equal(0n);
            expect(details.invested).to.equal(true);

            await fixture.mockToken.mint(fixture.poolAddress, yieldAmount);
            await fixture.mockAavePool.simulateYield(fixture.tokenAddress, manager, yieldAmount);

            await expect(fixture.dfsEscrowManager.connect(fixture.organizer).withdrawEscrowFunds(1, principal + yieldAmount))
                .to.emit(fixture.dfsEscrowManager, "EscrowWithdrawn");

            details = await fixture.dfsEscrowManager.getEscrowDetails(1);
            expect(details.escrowBalance).to.equal(principal + yieldAmount);

            const winnersTotal = usdc("100");
            const overflowBefore = await fixture.mockToken.balanceOf(fixture.contributor.address);
            await fixture.dfsEscrowManager.connect(fixture.organizer).distributeWinnings(
                1,
                [fixture.participant1.address, fixture.participant2.address],
                [usdc("40"), usdc("60")]
            );

            expect(await fixture.mockToken.balanceOf(fixture.contributor.address)).to.equal(
                overflowBefore + (principal + yieldAmount - winnersTotal)
            );
        });
    });

    describe("C) Multi-escrow concurrent investment", function () {
        it("withdraws pro-rata for first and sweeps remainder for last", async function () {
            const fixture = await loadFixture(deployFixture);
            const endTime = (await time.latest()) + 7200;

            await createEscrow(fixture, { dues: usdc("100"), leagueName: "A", endTime });
            await createEscrow(fixture, { dues: usdc("200"), leagueName: "B", endTime });

            const manager = await fixture.dfsEscrowManager.getAddress();

            await fixture.mockToken.mint(fixture.participant1.address, usdc("300"));
            await fixture.mockToken.connect(fixture.participant1).approve(manager, usdc("300"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(2, 1);

            await time.increaseTo(endTime + 1);
            await fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1);
            await fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(2);

            await fixture.mockToken.mint(fixture.poolAddress, usdc("9"));
            await fixture.mockAavePool.simulateYield(fixture.tokenAddress, manager, usdc("9"));

            await fixture.dfsEscrowManager.connect(fixture.organizer).withdrawEscrowFunds(1, usdc("103"));
            await fixture.dfsEscrowManager.connect(fixture.organizer).withdrawEscrowFunds(2, usdc("206"));

            const detailsA = await fixture.dfsEscrowManager.getEscrowDetails(1);
            const detailsB = await fixture.dfsEscrowManager.getEscrowDetails(2);
            expect(detailsA.escrowBalance).to.equal(usdc("103"));
            expect(detailsB.escrowBalance).to.equal(usdc("206"));
            expect(await fixture.dfsEscrowManager.totalPrincipalInPool(fixture.tokenAddress)).to.equal(0n);
        });
    });

    describe("D) Invest guards", function () {
        it("reverts before endTime", async function () {
            const fixture = await loadFixture(deployFixture);
            await createEscrow(fixture, { dues: usdc("10") });
            await fixture.mockToken.mint(fixture.participant1.address, usdc("10"));
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), usdc("10"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);

            await expect(fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1))
                .to.be.revertedWithCustomError(fixture.dfsEscrowManager, "EscrowNotEnded");
        });

        it("reverts for pool=address(0)", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, { pool: ethers.ZeroAddress, dues: usdc("10") });
            await fixture.mockToken.mint(fixture.participant1.address, usdc("10"));
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), usdc("10"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);
            await time.increaseTo(endTime + 1);

            await expect(fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1))
                .to.be.revertedWithCustomError(fixture.dfsEscrowManager, "NoPoolConfigured");
        });

        it("reverts when already invested", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, { dues: usdc("10") });
            await fixture.mockToken.mint(fixture.participant1.address, usdc("10"));
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), usdc("10"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);
            await time.increaseTo(endTime + 1);
            await fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1);

            await expect(fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1))
                .to.be.revertedWithCustomError(fixture.dfsEscrowManager, "AlreadyInvested");
        });

        it("reverts for zero escrow balance", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, { dues: usdc("10") });
            await time.increaseTo(endTime + 1);
            await expect(fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1))
                .to.be.revertedWithCustomError(fixture.dfsEscrowManager, "NothingToInvest");
        });

        it("reverts for non-organizer/non-owner", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, { dues: usdc("10") });
            await fixture.mockToken.mint(fixture.participant1.address, usdc("10"));
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), usdc("10"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);
            await time.increaseTo(endTime + 1);

            await expect(fixture.dfsEscrowManager.connect(fixture.outsider).investEscrowFunds(1))
                .to.be.revertedWithCustomError(fixture.dfsEscrowManager, "NotOrganizerOrOwner");
        });
    });

    describe("E) Withdraw guards", function () {
        it("reverts before invest", async function () {
            const fixture = await loadFixture(deployFixture);
            await createEscrow(fixture);
            await expect(fixture.dfsEscrowManager.connect(fixture.organizer).withdrawEscrowFunds(1, 0))
                .to.be.revertedWithCustomError(fixture.dfsEscrowManager, "NotInvested");
        });

        it("reverts when already withdrawn", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, { dues: usdc("10") });
            await fixture.mockToken.mint(fixture.participant1.address, usdc("10"));
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), usdc("10"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);
            await time.increaseTo(endTime + 1);
            await fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1);
            await fixture.dfsEscrowManager.connect(fixture.organizer).withdrawEscrowFunds(1, 0);

            await expect(fixture.dfsEscrowManager.connect(fixture.organizer).withdrawEscrowFunds(1, 0))
                .to.be.revertedWithCustomError(fixture.dfsEscrowManager, "AlreadyWithdrawn");
        });

        it("reverts when minExpectedAssets is too high", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, { dues: usdc("10") });
            await fixture.mockToken.mint(fixture.participant1.address, usdc("10"));
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), usdc("10"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);
            await time.increaseTo(endTime + 1);
            await fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1);

            await expect(fixture.dfsEscrowManager.connect(fixture.organizer).withdrawEscrowFunds(1, usdc("11")))
                .to.be.revertedWithCustomError(fixture.dfsEscrowManager, "InsufficientWithdrawn");
        });

        it("reverts for non-organizer/non-owner", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, { dues: usdc("10") });
            await fixture.mockToken.mint(fixture.participant1.address, usdc("10"));
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), usdc("10"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);
            await time.increaseTo(endTime + 1);
            await fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1);

            await expect(fixture.dfsEscrowManager.connect(fixture.outsider).withdrawEscrowFunds(1, 0))
                .to.be.revertedWithCustomError(fixture.dfsEscrowManager, "NotOrganizerOrOwner");
        });
    });

    describe("F) Distribute guards and existing behavior", function () {
        it("reverts while invested but not withdrawn", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, { dues: usdc("10") });
            await fixture.mockToken.mint(fixture.participant1.address, usdc("10"));
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), usdc("10"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);
            await time.increaseTo(endTime + 1);
            await fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1);

            await expect(
                fixture.dfsEscrowManager.connect(fixture.organizer).distributeWinnings(1, [fixture.participant1.address], [usdc("10")])
            ).to.be.revertedWithCustomError(fixture.dfsEscrowManager, "MustWithdrawFirst");
        });

        it("reverts when payout exceeds escrowBalance", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, { pool: ethers.ZeroAddress, dues: usdc("10") });
            await fixture.mockToken.mint(fixture.participant1.address, usdc("10"));
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), usdc("10"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);
            await time.increaseTo(endTime + 1);

            await expect(
                fixture.dfsEscrowManager.connect(fixture.organizer).distributeWinnings(1, [fixture.participant1.address], [usdc("11")])
            ).to.be.revertedWithCustomError(fixture.dfsEscrowManager, "InsufficientPool");
        });

        it("preserves existing distribute invariants", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, { pool: ethers.ZeroAddress, dues: usdc("10") });
            await fixture.mockToken.mint(fixture.participant1.address, usdc("10"));
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), usdc("10"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);
            await time.increaseTo(endTime + 1);

            await expect(
                fixture.dfsEscrowManager.connect(fixture.organizer).distributeWinnings(1, [fixture.participant1.address], [usdc("10"), usdc("0")])
            ).to.be.revertedWithCustomError(fixture.dfsEscrowManager, "PayoutArraysMismatch");

            await expect(
                fixture.dfsEscrowManager.connect(fixture.organizer).distributeWinnings(
                    1,
                    [fixture.participant1.address, fixture.participant1.address],
                    [usdc("5"), usdc("5")]
                )
            ).to.be.revertedWithCustomError(fixture.dfsEscrowManager, "NoDuplicateWinners");

            await expect(
                fixture.dfsEscrowManager.connect(fixture.organizer).distributeWinnings(1, [fixture.participant2.address], [usdc("5")])
            ).to.be.revertedWithCustomError(fixture.dfsEscrowManager, "WinnerNotParticipant");

            const tooManyRecipients = Array(101).fill(fixture.participant1.address);
            const tinyPayouts = Array(101).fill(1n);
            await expect(
                fixture.dfsEscrowManager.connect(fixture.organizer).distributeWinnings(1, tooManyRecipients, tinyPayouts)
            ).to.be.revertedWithCustomError(fixture.dfsEscrowManager, "TooManyRecipients");

            await expect(
                fixture.dfsEscrowManager.connect(fixture.outsider).distributeWinnings(1, [], [])
            ).to.be.revertedWithCustomError(fixture.dfsEscrowManager, "NotOrganizer");
        });
    });

    describe("G) Allowlist enforcement", function () {
        it("reverts for non-allowed pool", async function () {
            const fixture = await loadFixture(deployFixture);
            const dues = usdc("10");
            const endTime = (await time.latest()) + 7200;
            await expect(
                fixture.dfsEscrowManager
                    .connect(fixture.organizer)
                    .createEscrow(fixture.tokenAddress, dues, endTime, "BadPool", 10, ethers.ZeroAddress, fixture.outsider.address)
            ).to.be.revertedWithCustomError(fixture.dfsEscrowManager, "PoolNotAllowed");
        });

        it("reverts for non-allowed token", async function () {
            const fixture = await loadFixture(deployFixture);
            const MockToken = await ethers.getContractFactory("MockToken");
            const otherToken = await MockToken.deploy();
            const dues = usdc("10");
            const endTime = (await time.latest()) + 7200;
            await expect(
                fixture.dfsEscrowManager
                    .connect(fixture.organizer)
                    .createEscrow(await otherToken.getAddress(), dues, endTime, "BadToken", 10, ethers.ZeroAddress, ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(fixture.dfsEscrowManager, "TokenNotAllowed");
        });

        it("owner can add and remove pools and tokens", async function () {
            const fixture = await loadFixture(deployFixture);
            await fixture.dfsEscrowManager.connect(fixture.owner).setAllowedPool(fixture.poolAddress, false);
            await fixture.dfsEscrowManager.connect(fixture.owner).setAllowedToken(fixture.tokenAddress, false);
            expect(await fixture.dfsEscrowManager.allowedPools(fixture.poolAddress)).to.equal(false);
            expect(await fixture.dfsEscrowManager.allowedTokens(fixture.tokenAddress)).to.equal(false);

            await fixture.dfsEscrowManager.connect(fixture.owner).setAllowedPool(fixture.poolAddress, true);
            await fixture.dfsEscrowManager.connect(fixture.owner).setAllowedToken(fixture.tokenAddress, true);
            expect(await fixture.dfsEscrowManager.allowedPools(fixture.poolAddress)).to.equal(true);
            expect(await fixture.dfsEscrowManager.allowedTokens(fixture.tokenAddress)).to.equal(true);
        });
    });

    describe("H) Pause enforcement", function () {
        it("reverts invest when investPaused", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, { dues: usdc("10") });
            await fixture.mockToken.mint(fixture.participant1.address, usdc("10"));
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), usdc("10"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);
            await time.increaseTo(endTime + 1);
            await fixture.dfsEscrowManager.connect(fixture.owner).setInvestPaused(true);
            await expect(fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1))
                .to.be.revertedWithCustomError(fixture.dfsEscrowManager, "InvestPaused");
        });

        it("reverts withdraw when withdrawPaused", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, { dues: usdc("10") });
            await fixture.mockToken.mint(fixture.participant1.address, usdc("10"));
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), usdc("10"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);
            await time.increaseTo(endTime + 1);
            await fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1);
            await fixture.dfsEscrowManager.connect(fixture.owner).setWithdrawPaused(true);
            await expect(fixture.dfsEscrowManager.connect(fixture.organizer).withdrawEscrowFunds(1, 0))
                .to.be.revertedWithCustomError(fixture.dfsEscrowManager, "WithdrawPaused");
        });

        it("create/join/distribute still work while invest/withdraw paused", async function () {
            const fixture = await loadFixture(deployFixture);
            await fixture.dfsEscrowManager.connect(fixture.owner).setInvestPaused(true);
            await fixture.dfsEscrowManager.connect(fixture.owner).setWithdrawPaused(true);

            const { dues, endTime } = await createEscrow(fixture, { pool: ethers.ZeroAddress, dues: usdc("10") });
            await fixture.mockToken.mint(fixture.participant1.address, dues);
            await fixture.mockToken.connect(fixture.participant1).approve(await fixture.dfsEscrowManager.getAddress(), dues);
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);
            await time.increaseTo(endTime + 1);
            await fixture.dfsEscrowManager.connect(fixture.organizer).distributeWinnings(1, [fixture.participant1.address], [dues]);
        });
    });

    describe("I) addToPool after invest", function () {
        it("includes post-invest additions in final distributable balance", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, {
                dues: usdc("100"),
                overflowRecipient: fixture.contributor.address,
            });
            const manager = await fixture.dfsEscrowManager.getAddress();

            await fixture.mockToken.mint(fixture.participant1.address, usdc("100"));
            await fixture.mockToken.connect(fixture.participant1).approve(manager, usdc("100"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);

            await time.increaseTo(endTime + 1);
            await fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1);

            await fixture.mockToken.mint(fixture.contributor.address, usdc("7"));
            await fixture.mockToken.connect(fixture.contributor).approve(manager, usdc("7"));
            await fixture.dfsEscrowManager.connect(fixture.contributor).addToPool(1, usdc("7"));

            await fixture.mockToken.mint(fixture.poolAddress, usdc("3"));
            await fixture.mockAavePool.simulateYield(fixture.tokenAddress, manager, usdc("3"));

            await fixture.dfsEscrowManager.connect(fixture.organizer).withdrawEscrowFunds(1, usdc("103"));
            const details = await fixture.dfsEscrowManager.getEscrowDetails(1);
            expect(details.escrowBalance).to.equal(usdc("110"));

            const overflowBefore = await fixture.mockToken.balanceOf(fixture.contributor.address);
            await fixture.dfsEscrowManager
                .connect(fixture.organizer)
                .distributeWinnings(1, [fixture.participant1.address], [usdc("100")]);

            expect(await fixture.mockToken.balanceOf(fixture.contributor.address)).to.equal(overflowBefore + usdc("10"));
        });
    });

    describe("J) Zero winners with yield", function () {
        it("sends principal + yield + post-invest adds to overflow", async function () {
            const fixture = await loadFixture(deployFixture);
            const { endTime } = await createEscrow(fixture, {
                dues: usdc("100"),
                overflowRecipient: fixture.contributor.address,
            });
            const manager = await fixture.dfsEscrowManager.getAddress();

            await fixture.mockToken.mint(fixture.participant1.address, usdc("100"));
            await fixture.mockToken.connect(fixture.participant1).approve(manager, usdc("100"));
            await fixture.dfsEscrowManager.connect(fixture.participant1).joinEscrow(1, 1);

            await time.increaseTo(endTime + 1);
            await fixture.dfsEscrowManager.connect(fixture.organizer).investEscrowFunds(1);

            await fixture.mockToken.mint(fixture.contributor.address, usdc("5"));
            await fixture.mockToken.connect(fixture.contributor).approve(manager, usdc("5"));
            await fixture.dfsEscrowManager.connect(fixture.contributor).addToPool(1, usdc("5"));

            await fixture.mockToken.mint(fixture.poolAddress, usdc("7"));
            await fixture.mockAavePool.simulateYield(fixture.tokenAddress, manager, usdc("7"));

            await fixture.dfsEscrowManager.connect(fixture.organizer).withdrawEscrowFunds(1, usdc("107"));

            const overflowBefore = await fixture.mockToken.balanceOf(fixture.contributor.address);
            await fixture.dfsEscrowManager.connect(fixture.organizer).distributeWinnings(1, [], []);
            expect(await fixture.mockToken.balanceOf(fixture.contributor.address)).to.equal(overflowBefore + usdc("112"));
        });
    });
});
