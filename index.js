const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();

// ✅ Middleware
app.use(cors());
app.use(express.json());

// ✅ Firebase Admin
const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ✅ MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@coffeestore.vf4l8z4.mongodb.net/?retryWrites=true&w=majority&appName=coffeeStore`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("parcelDB");
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");

    // ✅ Firebase auth middleware
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader)
        return res.status(401).send({ message: "unauthorized access!" });
      const token = authHeader.split(" ")[1];
      if (!token)
        return res.status(401).send({ message: "unauthorized access" });

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    // ✅ 1. Search user by email
    app.get("/users/search", async (req, res) => {
      try {
        const emailQuery = req.query.email;
        if (!emailQuery) {
          return res.status(400).send({ message: "Email query is required" });
        }

        const regex = new RegExp(emailQuery, "i"); // case-insensitive partial match

        const users = await usersCollection
          .find({ email: { $regex: regex } })
          // .project({ email: 1, createdAt: 1, role: 1 })
          .limit(10)
          .toArray();

        if (users.length === 0) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send(users); // একসাথে সব matching user পাঠানো হচ্ছে
      } catch (error) {
        console.error("Error searching users:", error);
        res.status(500).send({ message: "Failed to search user" });
      }
    });
    // ✅ 2. Make user Admin
    app.patch("/users/:id/role", async (req, res) => {
      try {
        const { id } = req.params;
        const { role } = req.body;

        if (!["admin", "user"].includes(role)) {
          return res.status(400).send({ message: "Invalid role!" });
        }

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "User not found!" });
        }

        res.send({ success: true, message: `User role updated to ${role}` });
      } catch (error) {
        console.error("Error updating user role:", error);
        res.status(500).send({ message: "Failed to update user role" });
      }
    });

    // ✅ Upsert User
    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        return res
          .status(200)
          .send({ message: "user already exist", insertedId: false });
      }
      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // ✅ Search users
    app.get("/users/search", async (req, res) => {
      try {
        const emailQuery = req.query.email;
        if (!emailQuery)
          return res.status(400).send({ error: "Email query is required" });

        const regex = new RegExp(emailQuery, "i");
        const users = await usersCollection
          .find({ email: { $regex: regex } })
          .project({ email: 1, role: 1, createdAt: 1 })
          .limit(10)
          .toArray();

        res.send(users);
      } catch (err) {
        console.error(err);
        res.status(500).send({ error: "Failed to search users" });
      }
    });

    // ✅ Parcels CRUD
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        const query = userEmail ? { created_by: userEmail } : {};
        const parcels = await parcelsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();
        res.status(200).send(parcels);
      } catch (error) {
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    app.post("/parcels", async (req, res) => {
      try {
        const parcel = req.body;
        parcel.createdAt = new Date();
        const result = await parcelsCollection.insertOne(parcel);
        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to create parcel" });
      }
    });

    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });
        res.send(parcel);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });

    // ✅ Riders CRUD
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    // ✅ Approve / Reject Rider
    app.patch("/riders/:id/status", async (req, res) => {
      try {
        const { id } = req.params;
        const { status, email } = req.body; // "active" or "rejected"

        if (!["active", "rejected"].includes(status)) {
          return res.status(400).send({ message: "Invalid status value" });
        }

        // Rider update
        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Rider not found" });
        }

        // Update user role if approved
        if (status === "active" && email) {
          await usersCollection.updateOne(
            { email },
            { $set: { role: "rider" } }
          );
        }

        res.send({ success: true, message: `Rider ${status} successfully` });
      } catch (error) {
        console.error(error);
        res
          .status(500)
          .send({ message: "Failed to update rider status", error });
      }
    });
    // ✅ Pending Riders
    app.get("/riders/pending", async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(pendingRiders);
      } catch (error) {
        res.status(500).send({ message: "Failed to load pending riders" });
      }
    });

    // ✅ Active Riders
    app.get("/riders/active", async (req, res) => {
      try {
        const activeRiders = await ridersCollection
          .find({ status: "active" })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(activeRiders);
      } catch (error) {
        res.status(500).send({ message: "Failed to load active riders" });
      }
    });

    // ✅ Deactivate Rider
    app.patch("/riders/deactivate/:id", async (req, res) => {
      try {
        const riderId = req.params.id;
        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          { $set: { status: "inactive" } }
        );

        if (result.modifiedCount > 0) {
          res.send({
            success: true,
            message: "Rider deactivated successfully",
          });
        } else {
          res.status(404).send({ success: false, message: "Rider not found" });
        }
      } catch (error) {
        res
          .status(500)
          .send({ success: false, message: "Server error", error });
      }
    });

    // ✅ Payments
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        if (req.decoded.email !== userEmail)
          return res.status(403).send({ message: "forbidden access" });

        const payments = await paymentsCollection
          .find({ email: userEmail })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(payments);
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, transactionId, amount, email, paymentMethod } =
          req.body;
        if (!parcelId || !ObjectId.isValid(parcelId))
          return res.status(400).send({ error: "Invalid parcelId" });

        // Update Parcel
        await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              payment_status: "paid",
              paymentDate: new Date(),
              transactionId,
            },
          }
        );

        // Save Payment
        const paymentDoc = {
          parcelId,
          email,
          transactionId,
          amount,
          paymentMethod,
          status: "succeeded",
          paid_at_string: new Date().toISOString(),
          createdAt: new Date(),
        };
        const paymentResult = await paymentsCollection.insertOne(paymentDoc);

        res.send({
          message: "Payment recorded successfully",
          insertedId: paymentResult.insertedId,
        });
      } catch (err) {
        res
          .status(500)
          .send({ error: "Internal Server Error", details: err.message });
      }
    });

    // ✅ Stripe Payment Intent
    app.post("/create-payment-intent", async (req, res) => {
      try {
        const amountInCents = req.body.amountInCents;
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        res.status(500).send({ error: err.message });
      }
    });

    // ✅ Ping MongoDB
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Successfully connected to MongoDB!");
  } finally {
    // keep connection open
  }
}
run().catch(console.dir);

// ✅ Test Route
app.get("/", (req, res) => {
  res.send("🚀 Parcel Server is Running");
});

// ✅ Server listen
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});
