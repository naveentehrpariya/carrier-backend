/**
 * Broker / Carrier Agreement — the contract text of the setup packet.
 *
 * Transcribed from "CMC CARRIER SETUP PACKET.pdf" (pages 6–11). The broker's
 * name, USDOT and MC are substituted from the tenant's onboarding settings so the
 * same template serves every tenant.
 *
 * Bump TEMPLATE_VERSION whenever a word of this text changes: every signed packet
 * stores the version it was signed under, and its PDF is stored as rendered, so
 * an edit here never rewrites a contract somebody already signed.
 */
const TEMPLATE_VERSION = 'broker-carrier-agreement-v2';

// The broker party of the agreement, as printed in the packet. One company, one
// admin — the client asked for this to be fixed rather than configurable, and the
// agreement carries no broker signature line.
const BROKER_PARTY = {
  name: 'Cross Miles Carrier Inc',
  mc: '1365834',
  dot: '3797909',
  phone: '437-383-3310',
};

function agreementClauses(broker) {
  const B = broker.name || 'the Broker';
  return [
    {
      heading: 'Broker Status.',
      text: `Broker is a freight broker which arranges for third party motor carriers to provide cargo transportation for its customers, in accordance with its role as legally defined under 49 U.S.C. § 13102 Definitions (2), 49 C.F.R. §371.2 and 49 U.S.C. § 14501(c)(1).`,
    },
    {
      heading: 'Carrier Status, Rights and Responsibility.',
      text: `Carrier will perform its Transportation Services for Broker and its Customers as an independent contractor and will not for any purpose be the agent of Broker or Broker’s Customers. Carrier has exclusive control and direction of the work Carrier performs pursuant to this Agreement. Carrier will not contract or take other action in Broker’s name without Broker’s prior written consent.`,
    },
    {
      text: `Carrier agrees to assume full responsibility for the payment of all local, state, federal and intra-provincial payroll taxes, and contributions or taxes for unemployment insurance, worker’s compensation insurance, pensions, and other social security or related protection with respect to the persons engaged by Carrier for Carrier’s performance of the transportation and related services, and Carrier shall indemnify, defend and hold Broker, and its Customer harmless there from. Carrier shall provide Broker, with Carrier’s Federal Tax ID number and a copy of Carrier’s IRS Form W-9 prior to commencing any transportation or related services for Broker, under this Agreement.`,
    },
    {
      heading: 'No Right to Lien or Delay Release of Cargo or Equipment.',
      text: `Carrier will not assert any lien or make any claim on any cargo or equipment, and no lien will attach against Broker, its Customers or any cargo or equipment, for failure of Broker, the Customer or any other third party to pay Carrier for charges due to Carrier.`,
    },
    {
      heading: 'Waiver of Rights.',
      text: `Carrier shall, notwithstanding any other terms of this Agreement, expressly waive all rights and remedies under Title 49 U.S.C., Subtitle IV, Part B to the extent they conflict with this Agreement.`,
    },
    {
      heading: 'Sub-Contract Prohibition.',
      text: `Carrier expressly agrees that all freight tendered to it by Broker shall be transported on equipment operated only under the authority of Carrier, and that Carrier shall not in any manner sub-contract, broker, or in any other form arrange for the freight to be transported by a third party without the prior written consent of Broker. If Carrier breaches this provision, Broker shall have the right of paying the monies it owes Carrier directly to the delivering Carrier, in lieu of payment to Carrier. Upon Broker’s payment to delivering Carrier, Carrier shall not be released from any liability to Broker under this agreement. In addition to the indemnity obligation reflected in this agreement the Carrier will be liable for consequential damages for violation of this clause of the agreement.`,
    },
    {
      heading: 'Authorities and Licenses; Compliance with Laws.',
      text: `Carrier warrants that it will provide physical transportation of shipments as a fully qualified motor carrier that holds all required federal and state operating authorities. If Carrier’s safety rating changes at any time during this Contract’s term or if Carrier is sold, merges or dissolves or experiences a change in control of ownership, Carrier will notify Broker immediately (within 24 hours). Carrier will comply with applicable federal, state and/or local laws and regulations (including obtaining all permits and licenses), and any representations or contractual clauses required thereby will be incorporated herein by reference or by operation of law.`,
    },
    {
      heading: 'Booking Confirmation.',
      text: `Carrier shall transport shipments arranged by Broker pursuant to carrier load or Booking confirmation sheet(s) included herewith or subsequently incorporated by reference (See Schedule A annexed hereto).`,
    },
    {
      heading: 'Compensation/Payment.',
      text: `Motor Carriers are paid after receipt of carrier invoice, along with the original signed BOL as soon as shipper pays ${B} for its services. If shipper fails to pay ${B} in a timely manner or Shipper does not pay ${B} for any reason, then Carrier agrees to seek payment directly from shipper and agrees not to hold ${B} liable for such payment. If Shipper fails to pay Broker for its services within the timely manner (30 days), then Broker thereby transfers all responsibilities of collecting all fees from Shipper directly to Carrier, and Carrier thereby agrees to release Broker from all responsibilities of collection of such fees, including any resulting fees or charges related to such collections, and shall indemnify Broker for any loss resulting from the non-payment for all services rendered.`,
    },
    {
      heading: 'Insurance.',
      text: `Carrier agrees to provide any insurance coverage’s required by any government body for the types of transportation and related services specified in load confirmation communications received from Broker. All insurance required by this Agreement must be written by an insurance company having a Best’s rating of “B+” VII or better and must be authorized to do business under the laws of the state(s) or province(s) in which Carrier provides the transportation and related services as specified in load confirmation communications received from Broker. Carrier’s insurance shall be primary and required to respond and pay prior to any other available coverage. Carrier agrees that Carrier, Carrier’s insurer(s), and anyone claiming by, through or under Carrier shall have no claim, right of action, or right of subrogation against Broker, its affiliates, or its Customer based on any loss or liability insured under the insurance stipulated herein. Carrier represents and warrants that it will continuously fulfill the requirements of this Section throughout the duration of this Agreement. Broker shall be notified in writing by Carrier’s insurance company at least thirty (30) days prior to the cancellation, change or non-renewal of the submitted insurance policies. Carrier shall at all times during the term of this agreement have and maintain in full force and effect, at its expense, (i) Motor Truck Cargo insurance or a superior equivalent, with limits for the full value of the cargo under carriage subject to a minimum limit never less than US$100,000 per shipment, a deductible no greater than US$10,000 per shipment and at least the same coverage limit and deductible per shipment while in storage or at a storage facility enroute to the consignee, (ii) Commercial Automobile Liability insurance with a combined single limit of not less than US$1,000,000 per occurrence and without aggregate limits, (iii) Commercial General Liability insurance, in a limit of not less than US$1,000,000 per occurrence, (iv) Worker’s Compensation insurance in the amounts required by statute, and Employer’s Liability insurance with limits not less than US$500,000 per occurrence, and (v) if Carrier provides Transportation Services for hazardous materials under United States Department of Transportation (“DOT”) regulations, public insurance including Commercial Automobile insurance limits required for the commodity transported under 49 C.F.R § 387.7 and 387.9 (or successor regulations thereto) and statutory required Commercial Automobile insurance limits pertaining to the hazard classification of the cargo as defined by DOT, an MCS-90 and Broadened Pollution Liability endorsements for limits required by law and full policy limits. Carrier shall, prior to providing transportation and related services pursuant to this Agreement, name Broker, as a certificate holder, as required on the foregoing insurance policies and shall cause its insurance company to issue a certificate to Broker, evidencing the foregoing. When Carrier provides Transportation Services that involve origins and destinations solely within Canada, Carrier shall be current in its remittances to the appropriate Worker's Compensation Board of the Carrier's province, shall provide a certificate issued by the appropriate Worker's Compensation Board of the Carrier's province certifying that the Carrier is not delinquent and is current in its remittances to that authority, and shall have such other insurance or higher coverage limits required by applicable Canadian national or provincial law or regulation. Insurance will meet or exceed the requirements of federal, state and/or Provincial regulatory bodies having jurisdiction over Carrier’s performances pursuant to this agreement. During this Contract’s term, the insurance policies required hereunder and any replacement policies will (i) insure the interests of Broker and, (ii) cover all drivers, equipment and cargo used in providing Transportation Services and (iii) not contain any exclusions or restrictions as to designated premises or project, pertaining to unattended equipment or cargo, for unscheduled equipment, for unscheduled drivers or cargo, for fraud or infidelity, for tarp warranty, for wetness or dampness, for geographical location in the United States, for trailers unattached to the power unit, or for a particular radius of operation.`,
    },
    {
      heading: 'Carrier Moving Perishables.',
      text: `Carrier will verify that the equipment is suitable for the transportation of food, dairy & milk products for human or animal consumption, as applicable, as well as for other perishables, and will comply with all applicable laws and regulations, including maintenance of permits and record keeping requirements, for food, dairy & and if milk is transported, comply with the procedures stipulated at the attached Exhibits A, B, C & D, incorporated as an integral part of this Agreement. Carrier warrants that the Carrier will inspect or hire a service representative to inspect a vehicle’s refrigeration or heating unit at least once each month. Carrier warrants that they shall maintain a record of each inspection of refrigeration or heating unit and retain the records of the inspection for a least one year. Copies of these records must be provided upon request to the carrier’s insurance company and Broker. Each unit will maintain temperature data loggers in good working condition and provide the temperature readings upon request.`,
    },
    {
      text: `Carrier warrants that they will maintain adequate fuel levels for the refrigeration or heating unit and assume full liability for claims and expenses incurred by the Broker or the shipper for failure to do so.`,
    },
    {
      text: `Carrier will maintain effective driver screening, training, qualification and monitoring procedures and will provide Broker with information about these procedures upon request. Carrier will cause its drivers and other Carrier Representatives to operate their vehicles and equipment in a proper and lawful manner and to maintain equipment used to provide the Transportation Services in good, safe, sanitary, disinfected and lawful operating condition at all times. Carrier will use equipment that has been cleaned and sanitized in accordance with reasonable efforts not to supply equipment for Transportation Services that has been previously used to transport other product. The Carrier must provide their cargo insurer with all records that relate to a loss and permit copies and abstracts to be made from them upon request. Broker’s customer is a third party beneficiary of this Agreement. The following rules shall apply: (a) Destination market value for lost or damaged cargo, no special or consequential damages unless by special agreement; (b) Claims will be filed with Carrier by Broker or Shipper.`,
    },
    {
      text: `Carrier will inspect all empty equipment before loading to determine whether it is in apparent good condition (i.e., it appears to be sound, roadworthy, clean, odor-free, dry, leakproof and free of contamination or infestation) to protect the cargo being transported, will reject any equipment that is not in apparent good condition, clean and disinfected and will immediately (no later than 60 minutes) inform Broker of its rejection. Carrier acknowledges that if Carrier fails to inspect the equipment when it has the opportunity to do so, Carrier assumes liability related to such failure, for damage or loss to product cargo transported in such equipment.`,
    },
    {
      text: `All vehicles used for the transportation of pasteurized milk and milk products shall be constructed and operated so that the milk and milk products are maintained at 7ºC (45ºF) or less and are protected from contamination. Milk tank cars, milk tank trucks, and portable shipping bins shall not be used to transport or contain any substances that may be toxic or harmful to humans.`,
    },
    {
      text: `Carrier will maintain compliance with California TRU Regulation under California Code of Regulations Title 13, Division 3, Chapter 9, Article 8, Section 2477, as applicable.`,
    },
    {
      heading: 'Shipping Document Execution.',
      text: `Carrier is to be named on the bill of lading as the “carrier of record.”`,
    },
    {
      heading: 'INDEMNIFICATION.',
      text: `CARRIER WILL INDEMNIFY, DEFEND AND HOLD HARMLESS BROKER, ITS AFFILIATES AND ITS CUSTOMERS (AS INTENDED THIRD PARTY BENEFICIARIES) FROM ANY AND AGAINST ALL LOSSES (as defined below) ARISING OUT OF OR IN CONNECTION WITH THE TRANSPORTATION SERVICES PROVIDED UNDER THIS CONTRACT, INCLUDING THE LOADING, UNLOADING, HANDLING, TRANSPORTATION, POSSESSION, CUSTODY, USE OR MAINTENANCE OF CARGO OR EQUIPMENT OR PERFORMANCE OF THIS CONTRACT (INCLUDING BREACH HEREOF) BY CARRIER OR ANY CARRIER REPRESENTATIVE. CARRIER’S OBLIGATION TO INDEMNIFY AND DEFEND SHALL NOT BE AFFECTED BY ALLEGED NEGLIGENCE OR WILLFUL MISCONDUCT OF BROKER, ITS AFFILIATES OR CUSTOMERS. IT IS THE INTENT OF THE PARTIES THAT THIS PROVISION BE CONSTRUED TO PROVIDE INDEMNIFICATION TO BROKER, ITS AFFILIATES AND CUSTOMERS TO THE MAXIMUM EXTENT PERMITTED BY LAW. IF THIS PROVISION IS FOUND IN ANY WAY TO BE OVERBROAD, IT IS THE PARTIES INTENT THAT THIS PROVISION BE ENFORCED TO ALLOW INDEMNIFICATION TO THE MAXIMUM EXTENT PERMISSIBLE.`,
    },
    {
      text: `“Losses” mean any and all losses, liabilities, obligations, personal injury, bodily injury, property damage, loss or theft of property, damages, penalties, actions, causes of action, claims, suits, demands, costs and expenses of any nature whatsoever, including reasonable attorneys’ and paralegals’ fees and other costs of defence, investigation and settlement, costs of containment, cleanup and remediation of spills, releases or other environmental contamination and costs of enforcement of indemnity obligations.`,
    },
    {
      heading: 'Carrier’s Cargo Liability.',
      text: `Carrier assumes full liability for the greater of replacement cost, Shipper’s/Consignor’s commercial invoice or market value for loss, damage or destruction of any and all goods or property tendered to Carrier by Broker, and for the full course of carriage. Carrier shall inspect each load at the time it is tendered to Carrier to assure its condition. If Carrier is tendered a load which is not in suitable condition, it shall notify Broker, immediately. Cargo which has been tendered to Carrier intact and released by Carrier in a damaged condition, or lost or destroyed subsequent to such tender to Carrier, shall be conclusively presumed to have been lost, damaged or destroyed by Carrier unless Carrier can establish otherwise by clear and convincing evidence. Deliveries with broker seals shall be rejected and declared a total loss for which the Carrier is held responsible. Carrier shall either pay Broker directly or allow Broker to deduct from the amount Broker owes Carrier, the amount of Customer’s full actual loss. Carrier agrees that it will assert no lien against cargo transported hereunder. Broker, shall deduct from the amount Broker otherwise owes Carrier, the Customer’s full actual loss of all claims that are not resolved within ninety (90) days of the date of the claim. Carrier agrees to indemnify Broker, for any payments relating to such loss or damage incurred hereunder. In the event of an accident, Carrier shall notify Broker immediately for further instructions. Carrier shall return all damaged shipments at its expense to the point of origin or to other points as instructed by Broker. Claims notification & salvage procedures will be followed in accordance with the procedure described in 49 C.F.R. §370.1-11. Carrier will make all payments pursuant to the provisions of this Section within thirty (30) days following receipt by Carrier of Customer’s invoice or demand and supporting documentation for the claim.`,
    },
    {
      heading: '8.1 Salvage Claims.',
      text: `Carrier shall waive any and all right of salvage or resale of any of Customer’s damaged goods and shall, at Broker’s reasonable request and direction, promptly return or dispose, at Carrier’s cost, any and all of Customer’s damaged and goods shipped by Carrier. Carrier shall not under any circumstance allow Customer’s goods to be sold or made available for sale or otherwise disposed of in any salvage markets, employee stores, or any other secondary outlets. In the event that damaged goods are returned to Customer and salvaged by Customer, Carrier shall receive a credit for the actual salvage value of such goods.`,
    },
    {
      heading: 'Governing Law; Consent to Jurisdiction and Integration.',
      text: `This Contract will be construed, to the extent not pre-empted by applicable federal law, under the laws of the State of California, without giving effect to any choice or conflict of law rules. Broker and Carrier waive all right to trial by jury in any action, suit or proceeding brought to enforce or defend any rights or remedies under this Contract. Each of the parties hereby irrevocably and unconditionally (i) submits to the exclusive jurisdiction of any federal or state court sitting in California in any suit, action or arising out of, connected with, related to, or incidental to the relationship established among them in connection with this Contract and (ii) waives, to the fullest extent permitted by law, any objection to venue or any defence of inconvenient forum in connection with any such court; provided however that jurisdiction for disputes regarding claims brought by third parties requiring Carrier’s indemnification hereunder may be effected in the courts where such third party claims are filed. This written Agreement, together with any load confirmation, contains the entire agreement between the parties and may only be modified by signed written agreement.`,
    },
    {
      heading: '9.1 Safety Rating.',
      text: `Carrier shall endeavour to maintain a satisfactory U.S. DOT Safety Rating but under no circumstances is Carrier allowed to provide services under this contract if their safety rating falls to “unsatisfactory.”`,
    },
    {
      heading: 'Confidentiality Obligations.',
      text: `Carrier acknowledges that in carrying out this Contract, it will learn proprietary information about Broker and its business, including its rates, services, personnel, computer systems, Customers, traffic volumes, origins and destinations, commodity types, shipment information and business practices (the “Information”). During this Contract’s term and for 12 months after its termination, Carrier will hold the Contract provisions and Information in confidence, restrict disclosure to those Carrier Representatives with a need to know, and not use the Information to Broker’s competitive detriment or for any purpose except as contemplated hereby. Carrier may disclose Information to the extent required by a governmental agency or under a court order, provided that Carrier notifies Broker of such requirements before disclosure.`,
    },
    {
      heading: '10.1 Nonsolicitation of Customers.',
      text: `During this Contract’s term and for 9 months after its termination, Carrier will not, and will cause the Carrier Representatives not, to directly or indirectly solicit or provide transportation services to any Customer without Broker’s prior written consent if (a) that Customer first became known to Carrier as a result of Broker’s engagement of Carrier, (b) the type of transportation services, such as the origins and destinations served or commodity types, provided to that Customer first became known to Carrier as a result of Broker’s engagement of Carrier or (c) the first shipment transported by Carrier for that Customer was tendered to Carrier by Broker. If Carrier or any Carrier Representative solicits a Customer in violation of this Section, Carrier shall pay to Broker as a commission 10% of the total charges, with a maximum of US$200 per shipment, for transportation services provided by Carrier to such Customer.`,
    },
    {
      heading: 'Savings Clause.',
      text: `If any provision of this Agreement or any Transportation Schedule is held to be invalid, the remainder of the Agreement or the Transportation Schedule shall remain in force and effect with the offensive term or condition being stricken to the extent necessary to comply with any conflicting law.`,
    },
    {
      text: `This Agreement shall be for the period of one (1) year and shall be automatically renewed unless cancelled. Either party may terminate this Agreement upon fifteen (15) days written notice. By signatory hereto, CARRIER represents that it has the authority and ability to enter into legally binding contracts and that CARRIER agrees to be bound by the terms and conditions of this Agreement effective immediately.`,
    },
  ];
}

module.exports = { TEMPLATE_VERSION, BROKER_PARTY, agreementClauses };
