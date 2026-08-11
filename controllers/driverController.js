const User = require('../db/Users');
const DriverProfile = require('../db/DriverProfile');
const catchAsync = require('../utils/catchAsync');
const JSONerror = require('../utils/jsonErrorHandler');
const logger = require('../utils/logger');
const bcrypt = require('bcrypt');
const { logActivity } = require('../utils/activityLogger');
const { normalizeCurrency } = require('../utils/fx');

const createCorporateId = async () => {
  let corporateID;
  let isUnique = false;
  while (!isUnique) {
    corporateID = `DRID${Math.floor(100000 + Math.random() * 900000)}`;
    const existingUser = await User.findOne({ corporateID }, null, { includeInactive: true });
    if (!existingUser) {
      isUnique = true;
    }
  }
  return corporateID;
};

exports.addDriver = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ status: false, message: 'Tenant context is required' });
    }
    const {
      name, email, password, country, phone, address, state, city, zipcode,
      rateCurrency,
      ratePerMile,
      ratePerMileSolo,
      ratePerMileTeam,
      cityHoursRate,
      licenseNumber, licenseState, licenseIssueDate, licenseExpiry,
      emails = [], phones = []
    } = req.body;

    const trimmedName = String(name || '').trim();
    const trimmedEmail = String(email || '').trim().toLowerCase();
    const trimmedPhone = String(phone || '').trim();
    const trimmedCountry = String(country || '').trim();
    const trimmedAddress = String(address || '').trim();

    if (!trimmedName || !trimmedEmail || !trimmedPhone || !trimmedCountry || !trimmedAddress) {
      return res.status(400).json({ status: false, message: 'Missing required fields' });
    }

    const isEmailUsed = await User.findOne(
      { email: trimmedEmail },
      null,
      { includeInactive: true }
    );
    if (isEmailUsed) {
      return res.json({ status: false, message: 'Your given email address is already used.' });
    }

    const corporateID = await createCorporateId();
    const plainPassword = password || Math.random().toString(36).slice(2);

    let companyId = req.user?.company?._id || req.user?.company || null;
    if (!companyId) {
      const Company = require('../db/Company');
      const foundCompany = await Company.findOne({ tenantId });
      if (foundCompany) companyId = foundCompany._id;
    }

    const user = await User.create({
      name: trimmedName,
      email: trimmedEmail,
      corporateID,
      created_by: req.user?._id,
      password: plainPassword,
      country: trimmedCountry,
      phone: trimmedPhone,
      address: trimmedAddress,
      state: state ? String(state).trim() : undefined,
      city: city ? String(city).trim() : undefined,
      zipcode: zipcode ? String(zipcode).trim() : undefined,
      permissions: ['driver'],
      company: companyId,
      position: 'Driver',
      tenantId,
      modulesCustomized: false
    });

    const normalizedEmails = [];
    if (trimmedEmail) normalizedEmails.push({ email: trimmedEmail, is_primary: true });
    (Array.isArray(emails) ? emails : []).forEach(e => {
      const cleanE = String(e || '').trim().toLowerCase();
      if (cleanE && cleanE !== trimmedEmail) normalizedEmails.push({ email: cleanE, is_primary: false });
    });

    const normalizedPhones = [];
    if (trimmedPhone) normalizedPhones.push({ phone: trimmedPhone, is_primary: true });
    (Array.isArray(phones) ? phones : []).forEach(p => {
      const cleanP = String(p || '').trim();
      if (cleanP && cleanP !== trimmedPhone) normalizedPhones.push({ phone: cleanP, is_primary: false });
    });

    const profile = await DriverProfile.create({
      tenantId,
      user: user._id,
      emails: normalizedEmails,
      phones: normalizedPhones,
      // Pay currency is set once, here. editDriver deliberately never updates it.
      rateCurrency: normalizeCurrency(rateCurrency, 'USD'),
      ratePerMile: Number(ratePerMileSolo ?? ratePerMile) || 0,
      ratePerMileSolo: Number(ratePerMileSolo ?? ratePerMile) || 0,
      ratePerMileTeam: Number(ratePerMileTeam ?? ratePerMile) || 0,
      cityHoursRate: Number(cityHoursRate) || 0,
      licenseNumber,
      licenseState,
      licenseIssueDate: licenseIssueDate ? new Date(licenseIssueDate) : undefined,
      licenseExpiry,
      createdBy: req.user?._id
    });

    user.password = undefined;
    logActivity(req, {
      action: 'CREATE',
      module: 'employee',
      description: `Added driver "${user.name}" (${user.email})`,
      resourceId: user._id,
      resourceName: user.name,
    });
    return res.status(201).json({
      status: true,
      message: 'Driver created successfully',
      user,
      profile
    });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.editDriver = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const { id } = req.params;
    const {
      name, email, country, phone, address, state, city, zipcode,
      ratePerMile,
      ratePerMileSolo,
      ratePerMileTeam,
      cityHoursRate,
      notes, licenseNumber, licenseState, licenseIssueDate, licenseExpiry,
      emails = [], phones = []
    } = req.body;

    const trimmedName = name ? String(name).trim() : undefined;
    const trimmedEmail = email ? String(email).trim().toLowerCase() : undefined;
    const trimmedPhone = phone ? String(phone).trim() : undefined;
    const trimmedCountry = country ? String(country).trim() : undefined;
    const trimmedAddress = address ? String(address).trim() : undefined;
    const trimmedState = state !== undefined ? String(state).trim() : undefined;
    const trimmedCity = city !== undefined ? String(city).trim() : undefined;
    const trimmedZipcode = zipcode !== undefined ? String(zipcode).trim() : undefined;

    const existedUser = await User.findOne({ _id: id, tenantId }, null, { includeInactive: true });
    if (!existedUser) {
      return res.status(404).json({ status: false, message: 'Driver not found' });
    }

    if (trimmedEmail && trimmedEmail !== existedUser.email) {
      const emailExists = await User.findOne({ email: trimmedEmail }, null, { includeInactive: true });
      if (emailExists) {
        return res.json({ status: false, message: 'Your given email address is already used.' });
      }
    }

    const user = await User.findOneAndUpdate(
      { _id: id, tenantId },
      { name: trimmedName, email: trimmedEmail, country: trimmedCountry, phone: trimmedPhone, address: trimmedAddress, state: trimmedState, city: trimmedCity, zipcode: trimmedZipcode },
      { new: true }
    );

    const normalizedEmails = [];
    if (trimmedEmail) normalizedEmails.push({ email: trimmedEmail, is_primary: true });
    emails.forEach(e => {
      const cleanE = String(e || '').trim().toLowerCase();
      if (cleanE && cleanE !== trimmedEmail) normalizedEmails.push({ email: cleanE, is_primary: false });
    });

    const normalizedPhones = [];
    if (trimmedPhone) normalizedPhones.push({ phone: trimmedPhone, is_primary: true });
    phones.forEach(p => {
      const cleanP = String(p || '').trim();
      if (cleanP && cleanP !== trimmedPhone) normalizedPhones.push({ phone: cleanP, is_primary: false });
    });

    const profile = await DriverProfile.findOneAndUpdate(
      { user: id, tenantId },
      {
        emails: normalizedEmails,
        phones: normalizedPhones,
        // `rateCurrency` is intentionally absent: the driver's pay currency is locked at creation.
        // Rate VALUES may be edited, but always in the currency they were created in — changing it
        // here would reinterpret every trip's existing rate_per_mile snapshot.
        ratePerMile: Number(ratePerMileSolo ?? ratePerMile) || 0,
        ratePerMileSolo: Number(ratePerMileSolo ?? ratePerMile) || 0,
        ratePerMileTeam: Number(ratePerMileTeam ?? ratePerMile) || 0,
        cityHoursRate: Number(cityHoursRate) || 0,
        notes,
        licenseNumber,
        licenseState,
        licenseIssueDate: licenseIssueDate ? new Date(licenseIssueDate) : undefined,
        licenseExpiry,
        updatedAt: Date.now()
      },
      { new: true, upsert: true }
    );

    logActivity(req, {
      action: 'UPDATE',
      module: 'employee',
      description: `Updated driver "${user.name}"`,
      resourceId: user._id,
      resourceName: user.name,
    });
    return res.json({
      status: true,
      message: 'Driver updated successfully',
      user,
      profile
    });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.driversLists = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ status: false, message: 'Tenant context is required', lists: [] });
    }
    const companyId = req.user?.company?._id || req.user?.company || null;
    const filter = {
      tenantId,
      $and: [
        { $or: [{ permissions: 'driver' }, { role: 0 }] },
        { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      ],
    };
    if (companyId) {
      filter.company = companyId;
    }
    const users = await User.find(filter, null, { includeInactive: true })
      .select('name email status tenantId createdAt position phone country address corporateID created_by permissions')
      .sort({ createdAt: -1 })
      .lean();

    const userIds = users.map(u => u._id);
    const profiles = await DriverProfile.find({ tenantId, user: { $in: userIds } }).lean();
    const profileMap = new Map(profiles.map(p => [String(p.user), p]));

    const lists = users.map(u => ({
      ...u,
      driverProfile: profileMap.get(String(u._id)) || null
    }));

    return res.status(200).json({
      status: true,
      lists,
      totalDocuments: lists.length
    });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.removeDriver = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ status: false, message: 'Tenant context is required' });
    }
    const id = req.params.id;
    const filter = { _id: id, tenantId };
    const user = await User.findOne(filter, null, { includeInactive: true });
    if (!user) {
      return res.status(404).json({ status: false, message: 'Driver not found' });
    }
    const deletedAt = new Date();
    // Free the email so the same address can be re-used for a new driver.
    // Compound unique index { tenantId, email } would otherwise block re-add.
    if (user.email && !user.email.startsWith('deleted_')) {
      user.email = `deleted_${deletedAt.getTime()}_${user.email}`;
    }
    user.deletedAt = deletedAt;
    user.status = 'inactive';
    await user.save({ validateBeforeSave: false });
    await DriverProfile.findOneAndUpdate({ tenantId, user: user._id }, { deletedAt: new Date() });
    logActivity(req, {
      action: 'DELETE',
      module: 'employee',
      description: `Removed driver "${user.name}"`,
      resourceId: user._id,
      resourceName: user.name,
    });
    return res.json({ status: true, message: 'Driver removed (soft delete)', userId: user._id });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});
