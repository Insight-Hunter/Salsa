<!-- apps/insighthunter-payroll/src/components/SalsaPayroll.svelte -->
<script lang="ts">
  import { onMount } from "svelte";
  export let companyId: string;

  let token = "";
  let loading = true;

  onMount(async () => {
    const res = await fetch("/api/payroll/session-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId }),
    });
    const data = await res.json();
    token = data.token;
    loading = false;
  });
</script>

<svelte:head>
  <!-- Salsa Express UI component (use version pinned by Salsa) -->
  <script src="https://cdn.salsa.dev/salsa-express/latest/salsa-express.js"></script>
</svelte:head>

{#if loading}
  <p>Loading payroll…</p>
{:else}
  <!-- Salsa Express embedded component -->
  <salsa-express
    token={token}
    theme="light"
    on:payroll-run-approved={(e) => console.log("Run approved", e.detail)}
    on:onboarding-complete={(e) => console.log("Onboarding done", e.detail)}
  />
{/if}
