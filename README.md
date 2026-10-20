<div align="center">

# 🐷 Finance Planner

**Spending · Net Worth · Retirement · Roth Conversion · Playground**
*One planner where the numbers you plan with are the numbers a real tax engine computes.*

<br/>

[![Live demo](https://img.shields.io/badge/▶_Live_Demo-Try_it_in_your_browser-2ea44f?style=for-the-badge)](https://vkreal.github.io/finance-planner/)
[![Pages build](https://github.com/vkreal/finance-planner/actions/workflows/pages.yml/badge.svg)](https://github.com/vkreal/finance-planner/actions)
[![Runs in your browser](https://img.shields.io/badge/data-100%25_in_your_browser-blue?style=for-the-badge)](#-privacy)

<br/>

[Live demo](https://vkreal.github.io/finance-planner/) · [The five views](#-the-five-views) · [Features](#-features) · [Two ways to run it](#-two-ways-to-run-it)

</div>

---

> [!TIP]
> **Just want to look?** Open the **[live demo](https://vkreal.github.io/finance-planner/)** — no account, no install. It opens on a fictional sample household so every view has something to show, and anything you type is stored only in your own browser.

## 💡 What it does

Finance Planner connects the questions households actually ask when retirement gets close:

| ❓ The question | ✅ Where it's answered |
| --- | --- |
| What do we really spend each month? | **Spending** |
| What do we own — and in which tax buckets? | **Net Worth** |
| How long does the money last? | **Retirement** |
| Which account should each year's spending come from? | **Roth Conversion** |
| What does *this one year* look like, tax-wise? | **Playground** |

…including the hard one most tools skip: **how to draw down pre-tax savings without tripping the ACA premium-credit cliff or Medicare IRMAA tiers.**

## 🧭 The five views

### 💸 Spending
Monthly spending measured the way money actually leaves the bank. Yearly and periodic bills (property tax, insurance) are smoothed into a true monthly cost next to the cash that went out, with a *"keep the lights on"* floor for the bills that can't be paused — plus slice-and-dice by category, bill, or month range.

### 🏦 Net Worth
A snapshot history of every account, each balance splittable across tax buckets — **Pre-tax · Taxable · Roth · HSA · College/529 · Cash**. Custodial accounts record without counting toward totals, property can be shown or hidden, and progress tracks against a target you set.

### 📈 Retirement
The whole pile, projected: deterministic growth, Monte Carlo simulation, and historical market sequences, with per-year detail you can drill into. Spending strategies include flat, phased (level, then gently declining), and **guardrails** that trim spending after down years — and a solver finds the maximum sustainable spending for a target success rate.

### 🔀 Roth Conversion
A multi-year, year-by-year plan for drawing down pre-tax money: ACA cliffs and benchmark premiums by household size, IRMAA tiers, tax brackets, the 0% / 15% / 20% capital-gains staircase, RMDs (Joint Life Table divisors included), Social Security timing, and survivor scenarios. The **Strategy Lab** scores saved strategies side by side — pre-tax first vs. taxable first, cliff-capped vs. bracket fills — on lifetime cost *and* ending wealth. The **Pretax Spending** tab answers the simple version: *how long does the pre-tax money last?*

### 🎛️ Playground
A single-year tax sandbox. Type in a year's interest, dividends, stock sales, and pre-tax withdrawals or conversions, and watch the income stack build against the bracket tops, the ACA cliff, and the IRMAA lines — with fill-to-the-top shortcuts and a plain-language readout of the year's tax, and what a sale leaves you after tax.

## ✨ Features

| | |
| --- | --- |
| 🧮 **A real tax engine, not formulas in cells** | Federal brackets, standard deductions, capital-gains stacking, ACA credits, and IRMAA — computed from versioned law tables, so a new tax year is a new table, not a rewrite. |
| 🎯 **Accuracy-tested** | The engine ships with an extensive fixture suite — hundreds of pinned cases — that runs against every change. |
| 🔐 **Encrypted backups** | Export and restore use an authenticated-encryption file format that works identically in the browser and server builds. Plain-text backups are labelled as unauthenticated. |
| 📄 **CSV import / export** | With safeguards against spreadsheet formula injection and malformed files. |
| 🕵️ **Privacy by construction** | The public demo contains only fictional sample data, and the hosted version keeps everything in your browser. |

## 🌟 Only here — what other planners don't do

Most retirement tools optimize tax brackets and stop there. Finance Planner was built around the constraints they leave out:

- **🎯 ACA-cliff-first draw sizing.** Each year's pre-tax draw is sized *last* — after the year's interest, dividends, and RMD are known — to land just under the ACA premium-credit cliff, defending a credit worth ~$19K a year that bracket-fill tools blow through without noticing. Benchmark premiums are priced per household size, and the plan follows the household as it steps down (family → couple → one spouse on Medicare).
- **🧾 Basis-tier sale order inside taxable.** When taxable money is sold — to spend, or to pay the tax bill — the engine sells your highest-basis money first, in tiers calibrated to a real tax return, so the sale itself doesn't crowd the income limits it's trying to respect.
- **⚖️ An honest scoreboard.** Strategies are scored on *both* lifetime tax cost *and* ending wealth — with the tax your heir will pay on leftover pre-tax money charged against the pile, so "leave it all in pre-tax" can't win by hiding its exit tax.
- **📅 Built for the December decision.** The plan mirrors how the money actually moves: one draw a year, decided in December when the year's income is nearly final, funding the *next* year's spending. Guardrails judge the finished year, not a January guess.
- **🤖 One engine, every surface.** The app, the browser build, and AI assistants all read the *same* contract-tested engine — ask a question in chat and the answer is the engine's number, not a model's arithmetic.
- **🔒 A full planner with no account.** Everything — engine included — runs in your browser on local storage, with encrypted backups that move between the browser and server builds. Serious planners usually want your data on their cloud; this one never sees it.

## 🔀 Two ways to run it

| | 🌐 Browser build | 🖥️ Server build |
| --- | --- | --- |
| **Where it runs** | Entirely in your browser (the Pages demo) | A small backend you host |
| **Your data** | Browser local storage | Server database, with sync |
| **Backups** | Encrypted files you keep | Server-side + encrypted files |
| **Best for** | Trying it, personal use on one machine | Multi-device households |

Both builds run the **same source and the same engine** — the numbers can't drift between them.

---

<div align="center">

*Made for households who'd rather see the math than trust a rule of thumb.*

**[▶ Open the live demo](https://vkreal.github.io/finance-planner/)**

</div>
