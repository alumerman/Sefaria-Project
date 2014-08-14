import hashlib
import urllib
import re
import bleach

from django.contrib.auth.models import User
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string

from sefaria.model.following import FollowersSet, FolloweesSet
from sefaria.model.notifications import NotificationSet
from sefaria.system.database import db
from sefaria.utils.users import user_link, user_links


class UserProfile(object):
	def __init__(self, id=None, slug=None):

		if slug: # Load profile by slug if passed
			profile = db.profiles.find_one({"slug": slug})
			if profile:
				self.__init__(id=profile["id"])
				return

		user = User.objects.get(id=id)

		self.first_name         = user.first_name
		self.last_name          = user.last_name
		self.email              = user.email

		self._id                = None  # Mongo ID of profile doc
		self.id                 = id    # user ID
		self.slug               = ""
 		self.position           = ""
		self.organization       = ""
		self.jewish_education   = []
		self.bio                = ""
		self.website            = ""
		self.location           = ""
		self.public_email       = ""
		self.youtube            = ""
		self.facebook           = ""
		self.twitter            = ""
		self.linkedin           = ""
		self.pinned_sheets      = []

		self.settings     =  {
			"email_notifications": "daily",
		}

		self._name_updated      = False 
		self._slug_updated      = False 

		# Update with saved profile doc in MongoDB
		profile = db.profiles.find_one({"id": id})
		if profile:
			self.update(profile)

		# Followers
		self.followers = FollowersSet(self.id)
		self.followees = FolloweesSet(self.id)

		# Gravatar
		default_image           = "http://inclusiveinnovationhub.org/assets/avatars/missing_large.png" # "http://www.sefaria.org/static/img/profile-default.png"
		gravatar_base           = "http://www.gravatar.com/avatar/" + hashlib.md5(user.email.lower()).hexdigest() + "?"
		self.gravatar_url       = gravatar_base + urllib.urlencode({'d':default_image, 's':str(250)})
		self.gravatar_url_small = gravatar_base + urllib.urlencode({'d':default_image, 's':str(80)})


	def update(self, obj):
		"""
		Update this object with the fields in dictionry 'obj'
		"""
		if "first_name" in obj or "last_name" in obj:
			if self.first_name != obj["first_name"] or self.last_name != obj["last_name"]:
				self._name_updated = True

		if "slug" in obj and obj["slug"] != self.slug:
			self._slug_updated = True

		self.__dict__.update(obj)

		return self

	def save(self):
		"""
		Save profile to DB, updated Django User object if needed
		"""
		# Sanitize & Linkify fields that allow HTML
		self.bio = bleach.linkify(self.bio)

		d = self.to_DICT()
		if self._id:
			d["_id"] = self._id
		db.profiles.save(d)

		# invalidate user links cache if needed
		if self._name_updated or self._slug_updated:
			global user_links
			if self.id in user_links:
				del user_links[self.id]
			self._slug_updated = False

		# store name changes on Django User object
		if self._name_updated:
			user = User.objects.get(id=self.id)
			user.first_name = self.first_name
			user.last_name  = self.last_name
			user.save()
			self._name_updated = False

		return self

	def errors(self):
		"""
		Returns a string with any validation errors, 
		or None if the profile is valid.
		"""
		# Slug
		if re.search("[^a-z0-9\-]", self.slug):
			return "Profile URLs may only contain lowercase letters, numbers and hyphens."

		existing = db.profiles.find_one({"slug": self.slug, "_id": {"$ne": self._id}})
		if existing:
			return "The Profile URL you have requested is already in use."

		return None

	def assign_slug(self):
		"""
		Set the slug according to the profile name,
		using the first available number at the end if duplicated exist
		"""
		slug = "%s-%s" % (self.first_name, self.last_name)
		slug = slug.lower()
		slug = slug.replace(" ", "-")
		slug = re.sub(r"[^a-z0-9\-]", "", slug)
		self.slug = slug
		dupe_count = 0
		while self.errors():
			dupe_count += 1
			self.slug = "%s%d" % (slug, dupe_count)

		return self

	def follows(self, uid):
		"""Returns true if this user follows uid"""
		return uid in self.followees.uids

	def followed_by(self, uid):
		"""Returns true if this user is followed by uid"""
		return uid in self.followers.uids

	def to_DICT(self):
		"""Return a json serializble dictionary this profile"""
		dictionary = {
			"id":               self.id,
			"slug":             self.slug,
			"position":         self.position,
			"organization":     self.organization,
			"jewish_education": self.jewish_education,
			"bio":              self.bio,
			"website":          self.website,
			"location":         self.location,
			"public_email":     self.public_email,
			"facebook":         self.facebook,
			"twitter":          self.twitter,
			"linkedin":         self.linkedin,
			"youtube":          self.youtube,
			"pinned_sheets":    self.pinned_sheets,
			"settings":         self.settings,
		}
		return dictionary

	def to_JSON(self):
		return json.dumps(self.to_DICT)


def email_unread_notifications(timeframe):
	"""
	Looks for all unread notifcations and sends each user one email with a summary.
	Marks any sent notifications as "read".

	timeframe may be:
	* 'daily'  - only send to users who have the daily email setting
	* 'weekly' - only send to users who have the weekly email setting
	* 'all'    - send all notifications
	"""

	users = db.notifications.find({"read": False}).distinct("uid")

	for uid in users:
		profile = UserProfile(id=uid)
		if profile.settings["email_notifications"] != timeframe and timeframe != 'all':
			continue
		notifications = NotificationSet().unread_for_user(uid)
		try:
			user = User.objects.get(id=uid)
		except User.DoesNotExist:
			continue

		message_html = render_to_string("email/notifications_email.html", { "notifications": notifications, "recipient": user.first_name })
		#message_text = util.strip_tags(message_html)
		subject      = "New Activity on Sefaria from %s" % notifications.actors_string()
		from_email   = "The Sefaria Project <hello@sefaria.org>"
		to           = user.email

		msg = EmailMultiAlternatives(subject, message_html, from_email, [to])
		msg.content_subtype = "html"  # Main content is now text/html
		#msg.attach_alternative(message_text, "text/plain")
		msg.send()

		notifications.mark_read(via="email")


def unread_notifications_count_for_user(uid):
	"""Returns the number of unread notifcations belonging to user uid"""
	return db.notifications.find({"uid": uid, "read": False}).count()


def annotate_user_list(uids):
	"""
	Returns a list of dictionaries giving details (names, profile links) 
	for the user ids list in uids.
	"""
	annotated_list = []
	for uid in uids:
		annotated = {
			"userLink": user_link(uid),
			"imageUrl": UserProfile(id=uid).gravatar_url_small,
		}
		annotated_list.append(annotated)

	return annotated_list