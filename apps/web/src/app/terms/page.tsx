import type { Metadata } from "next";
import { LEGAL, LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = { title: "Terms of service | Basalt", description: "The terms for using Basalt." };

export default function Page() {
  return <LegalPage title="Terms of service">
    <p>These terms are an agreement between {LEGAL.company} (&quot;we&quot;) and the organization using Basalt (&quot;you&quot;). By using Basalt, you accept them. If you accept for an organization, you confirm you have authority to bind it. A signed agreement between us takes priority over these terms.</p>

    <h2>Using Basalt</h2>
    <p>You may use Basalt for your internal business purposes during your subscription. You&apos;re responsible for your members, their roles, and keeping sign-in details safe.</p>

    <h2>Acceptable use</h2>
    <p>You agree not to:</p>
    <ul>
      <li>break the law or infringe the rights of others;</li>
      <li>connect or load data you have no right to use;</li>
      <li>probe, attack or get around the security of Basalt, or access another customer&apos;s data;</li>
      <li>resell Basalt, or copy it to build a competing product, unless we agree in writing.</li>
    </ul>

    <h2>Your data</h2>
    <p>You keep all rights to the data you connect, import or enter. You let us process it only to provide Basalt and as you direct. You&apos;re responsible for having the right to use it, and for your masking, row access and sharing settings, including anything you publish through public form links, webhooks or tokens.</p>

    <h2>Third-party services and connectors</h2>
    <p>Basalt can connect to services and run connectors from other providers. They&apos;re covered by their own terms and licenses, and we aren&apos;t responsible for them. Product names belong to their owners and don&apos;t imply endorsement.</p>

    <h2>Our rights</h2>
    <p>We keep all rights to Basalt and its software, apart from third-party components under their own licenses. If you send us feedback, we may use it freely.</p>

    <h2>Fees</h2>
    <p>Fees and billing terms are set out in your order or agreement with us.</p>

    <h2>Suspension and ending</h2>
    <p>You can stop using Basalt at any time, subject to your order. We may suspend or end access if you seriously breach these terms, or if needed to protect Basalt or others. Export any data you need before access ends.</p>

    <h2>Disclaimer</h2>
    <p>To the extent the law allows, Basalt is provided &quot;as is&quot; without warranties of any kind, including merchantability, fitness for a particular purpose and non-infringement. Check important results before relying on them.</p>

    <h2>Limit of liability</h2>
    <p>To the extent the law allows, neither of us is liable for indirect, incidental, special or consequential damages, or for lost profits or data. Our total liability is limited to the amount you paid us in the 12 months before the claim.</p>

    <h2>Indemnity</h2>
    <p>You&apos;ll defend us against third-party claims arising from your data or your breach of the acceptable use terms.</p>

    <h2>Governing law</h2>
    <p>These terms are governed by the laws of the State of {LEGAL.state}, without regard to conflict-of-law rules, and disputes go to the courts located there.</p>

    <h2>Changes</h2>
    <p>If we change these terms, we&apos;ll update the date at the top of this page. Continuing to use Basalt after a change means you accept it.</p>

    <h2>Contact</h2>
    <p>{LEGAL.company}, {LEGAL.address}, {LEGAL.email}.</p>
  </LegalPage>;
}
