import type { Metadata } from "next";
import { LEGAL, LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = { title: "Privacy policy | Basalt", description: "What Basalt collects, why, and the choices you have." };

export default function Page() {
  return <LegalPage title="Privacy policy">
    <p>This policy explains how {LEGAL.company} (&quot;we&quot;) handles personal information when you visit this website or use Basalt.</p>

    <h2>Information we collect</h2>
    <ul>
      <li><b>Sales requests.</b> Your name, work email, company, team size, data sources and message when you use the Talk to sales form.</li>
      <li><b>Accounts.</b> Your name, email, role and a hashed password. If your organization uses single sign-on, we receive your identity from its provider.</li>
      <li><b>Activity records.</b> An audit log of actions such as sign-ins, changes to access and changes to data or structure, along with run history.</li>
      <li><b>Technical information.</b> IP addresses, used to limit repeated requests and in server logs.</li>
      <li><b>Customer data.</b> Data your organization connects, imports, streams or enters in Basalt, including attachments, comments and public form submissions. Your organization decides what this is, and it may include personal information.</li>
    </ul>

    <h2>How we use it</h2>
    <p>We use this information to respond to requests, provide and secure Basalt, sign you in, enforce access rules, send the emails you or your organization set up, and meet legal obligations. We don&apos;t sell personal information, and we don&apos;t use customer data for advertising.</p>

    <h2>Customer data</h2>
    <p>We process customer data on behalf of the organization that controls it. If you&apos;re a member of an organization using Basalt, send requests about that data to your organization&apos;s administrator. Administrators choose which columns are masked, held back or restricted.</p>

    <h2>Cookies and local storage</h2>
    <p>Basalt uses one essential cookie to keep you signed in, which lasts up to 7 days. Signing in with single sign-on also uses a second essential cookie for up to 10 minutes. Your browser also stores preferences such as layout and recent items on your device. We don&apos;t use advertising or analytics cookies.</p>

    <h2>Who we share it with</h2>
    <ul>
      <li>Service providers that help us run Basalt, under obligations to protect the information.</li>
      <li>Services your organization connects, such as databases, cloud storage, email servers, webhooks, lineage tools and connectors. Their own terms and policies apply.</li>
      <li>Authorities or others when the law requires it, or to protect rights and safety, and a successor if the business is sold or merged.</li>
    </ul>

    <h2>Security</h2>
    <p>Connection passwords are encrypted when stored and aren&apos;t sent back to the browser, and passwords are stored hashed. No system is perfectly secure, and we can&apos;t guarantee absolute security.</p>

    <h2>Retention</h2>
    <p>We keep information for as long as needed for the purposes above, or as the law requires. Customer data is kept until your organization removes it or the service ends.</p>

    <h2>Your choices and rights</h2>
    <p>Depending on where you live, including California and other US states, you may have the right to know, access, correct or delete your personal information, and not to be treated differently for using those rights. To make a request, email {LEGAL.email}. We may need to confirm your identity first.</p>

    <h2>Children</h2>
    <p>Basalt is for business use and isn&apos;t directed to children under 13.</p>

    <h2>Changes</h2>
    <p>If we change this policy, we&apos;ll update the date at the top of this page.</p>

    <h2>Contact</h2>
    <p>{LEGAL.company}, {LEGAL.address}, {LEGAL.email}.</p>
  </LegalPage>;
}
